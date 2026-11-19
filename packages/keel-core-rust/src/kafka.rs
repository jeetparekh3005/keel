//! Kafka `MessageBus` adapter (ADR-0025), parity with the NATS JetStream adapter in
//! [`crate::messaging`] and the RabbitMQ adapter in [`crate::rabbitmq`], and a direct port of the
//! proven Go Kafka adapter.
//!
//! A `subject` maps to a Kafka topic (non-alphanumeric sanitized exactly as the NATS durable name
//! is), publishing produces to that topic via an `rdkafka` [`FutureProducer`], and consumption runs
//! through a consumer group with auto-commit OFF so the record's offset is committed only after the
//! handler acks. The delivery contract is identical to the other adapters: trace context (W3C
//! `traceparent`/`tracestate`) is injected into record headers on publish and re-attached around
//! each handler; on handler failure below the cap the record is re-produced to a retry topic
//! (`<topic>.retry`) with an incremented delivery-count header and the original offset committed so
//! the partition is not head-of-line blocked, and at the cap it is produced to the dead-letter topic
//! (`<topic>.dlq`, overridable) and committed, so a poison record neither loops forever nor is
//! dropped silently. Kafka has no native per-message delivery count, so it travels in a
//! `keel-delivery-count` record header. The ack/retry/dead-letter decision reuses the broker-agnostic
//! [`disposition`](crate::messaging::disposition) policy; the produce-then-commit-vs-preserve decision
//! is the pure [`commit_after_produce`] helper (mirroring
//! [`dead_letter_disposition`](crate::rabbitmq) in the RabbitMQ adapter): if the retry/DLQ produce
//! fails the original offset is NOT committed, so the record is redelivered rather than lost.
//!
//! Gated behind the `kafka` feature (it pulls in `rdkafka`/librdkafka, the ADR-0025 C-dependency
//! exception); the default core build stays broker-free, exactly like the `nats`/`rabbitmq` features.
//! librdkafka is vendored and statically built from source WITHOUT SSL/SASL (keel's Kafka is
//! PLAINTEXT), so no `openssl-sys`/`libsasl` enters the tree (guarded by `deny.toml`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use opentelemetry::propagation::{Injector, TextMapPropagator};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::error::KafkaError;
use rdkafka::message::{BorrowedHeaders, BorrowedMessage, Header, Headers, Message, OwnedHeaders};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::util::Timeout;
use tracing::{error, info_span, warn, Instrument};
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::messaging::{
    disposition, extract_trace_context, Disposition, InboundMessage, MessageBus, MessageHandler,
    MessagePublisher, MessagingError,
};

/// Carries the portable redelivery count Kafka does not track natively; it is incremented each time
/// a failed record is re-produced to the retry topic.
const DELIVERY_COUNT_HEADER: &str = "keel-delivery-count";

/// Carries the ORIGINAL subject a record was published to, before the lossy subject -> topic
/// sanitization (`keel.test.events` -> topic `keel_test_events`). Unlike NATS/RabbitMQ, where the
/// subject IS the routing key and round-trips intact, a Kafka topic is a lossy transform of the
/// subject, so the original must travel explicitly: `publish` stamps it and consume restores
/// [`InboundMessage::subject`] from it (falling back to the topic name when absent), so the
/// delivered subject equals the published subject. Like `keel-delivery-count` and the trace
/// headers, it is carried through verbatim on the re-produce to `<topic>.retry` / `<topic>.dlq`.
const SUBJECT_HEADER: &str = "keel-subject";

/// Names the retry and dead-letter topics derived from a base topic.
const RETRY_SUFFIX: &str = ".retry";
const DLQ_SUFFIX: &str = ".dlq";

/// Delivery policy and topology for a [`KafkaMessageBus`]. Defaults mirror the Go adapter and
/// ADR-0025: topics `[keel]`, group `keel`, no DLQ override (per-topic `<topic>.dlq`),
/// `max_deliver = 5`.
#[derive(Debug, Clone)]
pub struct KafkaConfig {
    /// Bootstrap servers (from the comma-separated `KEEL_KAFKA_BROKERS`); the gate, a bus is built
    /// only when it is set.
    pub brokers: Vec<String>,
    /// The subjects/topics the consumer group subscribes to (`KEEL_KAFKA_TOPICS`), defaulting to
    /// `keel`. Each is sanitized to a legal topic and its `<topic>.retry` sibling is consumed too.
    pub topics: Vec<String>,
    /// The consumer group (`KEEL_KAFKA_GROUP_ID`), defaulting to `keel`.
    pub group_id: String,
    /// Overrides the per-topic `<topic>.dlq` dead-letter destination with a single shared
    /// dead-letter topic (`KEEL_KAFKA_DLQ_TOPIC`); `None`/empty keeps the per-topic default.
    pub dlq_topic: Option<String>,
    /// Redelivery cap before a failing record is dead-lettered.
    pub max_deliver: i64,
}

impl KafkaConfig {
    /// Build a config with the default topology and delivery policy for the given bootstrap servers.
    #[must_use]
    pub fn new(brokers: Vec<String>) -> Self {
        Self {
            brokers,
            topics: vec!["keel".to_string()],
            group_id: "keel".to_string(),
            dlq_topic: None,
            max_deliver: 5,
        }
    }

    /// Build a config from the environment, returning `None` when the `KEEL_KAFKA_BROKERS` gate is
    /// unset or empty (so the default, broker-free deployment never constructs a Kafka bus),
    /// mirroring the env gates of the secret-provider adapters. `KEEL_KAFKA_TOPICS` and
    /// `KEEL_KAFKA_GROUP_ID` default to `keel`; `KEEL_KAFKA_DLQ_TOPIC` is the optional DLQ override.
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let brokers = split_csv(&std::env::var("KEEL_KAFKA_BROKERS").ok()?);
        if brokers.is_empty() {
            return None;
        }
        let topics = std::env::var("KEEL_KAFKA_TOPICS")
            .ok()
            .map(|value| split_csv(&value))
            .filter(|topics| !topics.is_empty())
            .unwrap_or_else(|| vec!["keel".to_string()]);
        let group_id = std::env::var("KEEL_KAFKA_GROUP_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "keel".to_string());
        let dlq_topic = std::env::var("KEEL_KAFKA_DLQ_TOPIC")
            .ok()
            .filter(|value| !value.trim().is_empty());
        Some(Self {
            brokers,
            topics,
            group_id,
            dlq_topic,
            max_deliver: 5,
        })
    }
}

/// Split a comma-separated env value into trimmed, non-empty entries.
fn split_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// A [`MessageBus`] backed by Kafka for durable at-least-once delivery.
///
/// Constructed already connected (see [`KafkaMessageBus::connect`]): the producer and the
/// consumer-group consumer are created and a metadata round-trip fails fast on an unreachable
/// broker, so there is no "connect before use" footgun and every `publish` / `subscribe` runs
/// against a live client.
pub struct KafkaMessageBus {
    producer: FutureProducer,
    consumer: Arc<StreamConsumer>,
    dlq_topic: Option<String>,
    max_deliver: i64,
    /// subject-topic -> handler, keyed by the sanitized base topic; a `<topic>.retry` record is
    /// routed back to the base topic's handler so the retry loop converges on one consumer.
    handlers: Arc<Mutex<HashMap<String, MessageHandler>>>,
    /// The set of topics currently subscribed (base topics and their retry siblings); subscribing a
    /// new subject re-subscribes the consumer to the union.
    subscribed: Arc<Mutex<HashSet<String>>>,
    started: Arc<AtomicBool>,
    tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl KafkaMessageBus {
    /// Connect to the cluster: build the `FutureProducer` and the consumer-group `StreamConsumer`
    /// (auto-commit OFF, pre-subscribed to the configured topics and their retry siblings), then do
    /// a metadata round-trip to fail fast on an unreachable broker. The client error is returned
    /// as-is: the broker list is never echoed into the error, so nothing sensitive leaks.
    ///
    /// # Errors
    /// Returns [`MessagingError::Connect`] if a client cannot be built or the cluster is
    /// unreachable, or [`MessagingError::Subscribe`] if the initial subscription fails.
    pub async fn connect(mut config: KafkaConfig) -> Result<Self, MessagingError> {
        if config.topics.is_empty() {
            config.topics = vec!["keel".to_string()];
        }
        if config.group_id.trim().is_empty() {
            config.group_id = "keel".to_string();
        }
        if config.max_deliver == 0 {
            config.max_deliver = 5;
        }
        let brokers = config.brokers.join(",");

        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", &brokers)
            .create()
            .map_err(connect_error)?;

        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", &brokers)
            .set("group.id", &config.group_id)
            // Auto-commit OFF: the offset is committed only after the handler acks (success) or the
            // record has a home on the retry/dead-letter topic, never before the work is done.
            .set("enable.auto.commit", "false")
            // Read from the start of a partition when the group has no committed offset, so a
            // record produced before the consumer's first fetch is still delivered (the broker
            // auto-creates the base/retry/dlq topics on first produce).
            .set("auto.offset.reset", "earliest")
            .set("allow.auto.create.topics", "true")
            // Discover newly-created topics (the adapter-owned <topic>.retry / <topic>.dlq come into
            // being on first produce) quickly rather than on the 5-minute default refresh interval.
            .set("topic.metadata.refresh.interval.ms", "2000")
            .create()
            .map_err(connect_error)?;

        // Fail fast on an unreachable broker (the Go adapter's Ping analogue): a real metadata
        // round-trip that errors if no broker answers within the timeout.
        consumer
            .fetch_metadata(None, Timeout::After(Duration::from_secs(10)))
            .map_err(connect_error)?;

        let mut subscribed = HashSet::new();
        for topic in &config.topics {
            let base = topic_name(topic);
            subscribed.insert(format!("{base}{RETRY_SUFFIX}"));
            subscribed.insert(base);
        }
        if !subscribed.is_empty() {
            let refs: Vec<&str> = subscribed.iter().map(String::as_str).collect();
            consumer
                .subscribe(&refs)
                .map_err(|err| MessagingError::Subscribe(err.to_string()))?;
        }

        Ok(Self {
            producer,
            consumer: Arc::new(consumer),
            dlq_topic: config.dlq_topic.filter(|topic| !topic.is_empty()),
            max_deliver: config.max_deliver,
            handlers: Arc::new(Mutex::new(HashMap::new())),
            subscribed: Arc::new(Mutex::new(subscribed)),
            started: Arc::new(AtomicBool::new(false)),
            tasks: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// Abort the background poll loop and drop the clients (call at shutdown).
    ///
    /// # Errors
    /// Infallible today; returns `Result` for parity with the other adapters' `close`.
    pub async fn close(self) -> Result<(), MessagingError> {
        for task in self.tasks.lock().expect("tasks lock").drain(..) {
            task.abort();
        }
        Ok(())
    }

    /// Spawn the single poll loop that fetches records and routes each to its registered handler via
    /// [`dispatch`] until the task is aborted. A fetch-level error is logged, not raised, so a
    /// transient broker hiccup does not tear down the consumer.
    fn spawn_poll_loop(&self) {
        let consumer = Arc::clone(&self.consumer);
        let producer = self.producer.clone();
        let handlers = Arc::clone(&self.handlers);
        let dlq_topic = self.dlq_topic.clone();
        let max_deliver = self.max_deliver;
        let handle = tokio::spawn(async move {
            loop {
                match consumer.recv().await {
                    Ok(message) => {
                        // A record on <topic>.retry is a retried delivery of the base topic; route
                        // it to the base topic's handler so the retry loop converges.
                        let base = base_topic(message.topic());
                        let handler = handlers.lock().expect("handlers lock").get(&base).cloned();
                        let Some(handler) = handler else {
                            continue;
                        };
                        dispatch(
                            &producer,
                            &consumer,
                            &message,
                            &handler,
                            dlq_topic.as_deref(),
                            max_deliver,
                        )
                        .await;
                    }
                    Err(err) => {
                        warn!(error = %err, "kafka consumer stream error");
                    }
                }
            }
        });
        self.tasks.lock().expect("tasks lock").push(handle);
    }
}

#[async_trait::async_trait]
impl MessagePublisher for KafkaMessageBus {
    async fn publish(
        &self,
        subject: &str,
        payload: &[u8],
        headers: &HashMap<String, String>,
    ) -> Result<(), MessagingError> {
        let mut carrier = headers.clone();
        // Carry the original subject explicitly: the topic is a lossy sanitization of it, so without
        // this header the consumer could only recover the sanitized topic, not the published subject.
        carrier.insert(SUBJECT_HEADER.to_string(), subject.to_string());
        inject_trace_context(&mut carrier);
        let owned = map_to_headers(&carrier);
        let topic = topic_name(subject);
        produce(&self.producer, &topic, None, Some(payload), owned).await
    }
}

#[async_trait::async_trait]
impl MessageBus for KafkaMessageBus {
    async fn subscribe(
        &self,
        subject: &str,
        handler: MessageHandler,
    ) -> Result<(), MessagingError> {
        let base = topic_name(subject);
        let retry = format!("{base}{RETRY_SUFFIX}");
        self.handlers
            .lock()
            .expect("handlers lock")
            .insert(base.clone(), handler);

        // Ensure the base topic and its retry sibling are consumed; re-subscribe the union only when
        // a new topic appears so an already-covered subject does not churn the group.
        let resubscribe = {
            let mut subscribed = self.subscribed.lock().expect("subscribed lock");
            let added_base = subscribed.insert(base);
            let added_retry = subscribed.insert(retry);
            if added_base || added_retry {
                Some(subscribed.iter().cloned().collect::<Vec<String>>())
            } else {
                None
            }
        };
        if let Some(topics) = resubscribe {
            let refs: Vec<&str> = topics.iter().map(String::as_str).collect();
            self.consumer
                .subscribe(&refs)
                .map_err(|err| MessagingError::Subscribe(err.to_string()))?;
        }

        // Start the poll loop on the first subscribe only.
        if !self.started.swap(true, Ordering::SeqCst) {
            self.spawn_poll_loop();
        }
        Ok(())
    }
}

/// Dispatch one delivered record to `handler` under its propagated trace context, then commit on
/// success, re-produce to the retry topic below the cap, or to the dead-letter topic at the cap, per
/// the shared [`disposition`] rule. The dead-letter decision is always logged: it drops the record
/// from redelivery, which must never be silent. If the re-produce to the retry or dead-letter topic
/// itself fails, the original offset is NOT committed (see [`commit_after_produce`]), so the record
/// is redelivered rather than lost; the offset is committed only once the record has a home. Never
/// returns an error: control-plane failures are logged, not propagated, so the poll loop keeps going.
async fn dispatch(
    producer: &FutureProducer,
    consumer: &StreamConsumer,
    message: &BorrowedMessage<'_>,
    handler: &MessageHandler,
    dlq_topic: Option<&str>,
    max_deliver: i64,
) {
    // `base` is the sanitized topic (drives retry/dlq derivation, handler lookup, and commit);
    // `subject` is the ORIGINAL published subject recovered from the keel-subject header, so the
    // delivered InboundMessage.subject equals what was published rather than the lossy topic name.
    let base = base_topic(message.topic());
    let headers = headers_to_map(message.headers());
    let subject = inbound_subject(&headers, &base);
    let inbound = InboundMessage {
        subject: subject.clone(),
        payload: message.payload().map(<[u8]>::to_vec).unwrap_or_default(),
        headers: headers.clone(),
    };

    // A consume span parented on the producer's remote trace, so handler log lines and any nested
    // spans link back to the publish side (the cross-broker trace link).
    let span = info_span!(
        "messaging.consume",
        messaging.system = "kafka",
        messaging.destination = %subject,
    );
    // Errs only when no OpenTelemetry subscriber is installed (export off), the same regime in which
    // spans are no-ops here; ignore rather than log on every record.
    let _ = span.set_parent(extract_trace_context(&headers));

    let outcome = handler(inbound).instrument(span).await;
    // keel-delivery-count counts prior failed attempts (absent on first delivery), so +1 gives the
    // 1-based attempt count the shared policy expects, matching the NATS `delivered` count.
    let num_delivered = delivery_count(&headers) + 1;

    match disposition(outcome.is_ok(), num_delivered, max_deliver) {
        Disposition::Ack => {
            control(
                consumer.commit_message(message, CommitMode::Sync),
                "commit",
                &base,
            );
        }
        Disposition::Redeliver => {
            if let Err(err) = &outcome {
                warn!(
                    subject = %base,
                    retry_topic = %format!("{base}{RETRY_SUFFIX}"),
                    num_delivered,
                    error = %err,
                    "message handler failed; scheduling redelivery",
                );
            }
            let retry_topic = format!("{base}{RETRY_SUFFIX}");
            let owned = headers_with_delivery_count(message.headers(), num_delivered);
            let produced = produce(
                producer,
                &retry_topic,
                message.key(),
                message.payload(),
                owned,
            )
            .await;
            commit_or_preserve(consumer, message, &base, produced, "retry", &retry_topic);
        }
        Disposition::DeadLetter => {
            let dlq = resolve_dlq(dlq_topic, &base);
            if let Err(err) = &outcome {
                // Dead-lettering drops the record from redelivery; this must never be silent, so log
                // the poison record's handler error at error.
                error!(
                    subject = %base,
                    dlq_topic = %dlq,
                    num_delivered,
                    max_deliver,
                    error = %err,
                    "message terminated after exhausting delivery attempts",
                );
            }
            // Preserve the original payload, key, and headers so the dead-lettered record is a
            // faithful copy of what failed.
            let owned = clone_headers(message.headers());
            let produced = produce(producer, &dlq, message.key(), message.payload(), owned).await;
            commit_or_preserve(consumer, message, &base, produced, "dead-letter", &dlq);
        }
    }
}

/// Commit the original offset only once the re-produced record has a home, PRESERVING it (leaving
/// the offset uncommitted for redelivery) if the produce failed. Centralizes the retry and
/// dead-letter post-produce decision so both go through the pure [`commit_after_produce`] policy.
fn commit_or_preserve(
    consumer: &StreamConsumer,
    message: &BorrowedMessage<'_>,
    base: &str,
    produced: Result<(), MessagingError>,
    kind: &str,
    destination: &str,
) {
    if let Err(err) = &produced {
        error!(
            subject = %base,
            destination = %destination,
            kind = %kind,
            error = %err,
            "re-produce failed; offset left uncommitted for redelivery",
        );
    }
    // Ack => the record has a home on the retry/dead-letter topic, so commit the original.
    // Redeliver (PRESERVE) => no home for the record, so leave the offset uncommitted and let the
    // consumer group redeliver it rather than silently drop it.
    if commit_after_produce(produced.is_ok()) == Disposition::Ack {
        control(
            consumer.commit_message(message, CommitMode::Sync),
            "commit",
            base,
        );
    }
}

/// Produce `payload` (with `key` and `headers`) to `topic`, awaiting the broker's delivery report so
/// the produce is reliable. A broker-reported failure maps to [`MessagingError::Publish`]; the
/// broker list is never echoed, so nothing sensitive leaks.
async fn produce(
    producer: &FutureProducer,
    topic: &str,
    key: Option<&[u8]>,
    payload: Option<&[u8]>,
    headers: OwnedHeaders,
) -> Result<(), MessagingError> {
    let mut record: FutureRecord<'_, [u8], [u8]> = FutureRecord::to(topic).headers(headers);
    if let Some(key) = key {
        record = record.key(key);
    }
    if let Some(payload) = payload {
        record = record.payload(payload);
    }
    producer
        .send(record, Timeout::After(Duration::from_secs(30)))
        .await
        .map(|_| ())
        .map_err(|(err, _message)| MessagingError::Publish(err.to_string()))
}

/// Map an `rdkafka` error into a no-leak [`MessagingError::Connect`]; the broker list is never
/// echoed into the error string.
fn connect_error(err: KafkaError) -> MessagingError {
    MessagingError::Connect(err.to_string())
}

/// Log (never raise) a control-plane (commit) failure so a redelivery or duplicate-processing
/// anomaly stays diagnosable while the poll loop keeps running.
fn control(result: Result<(), KafkaError>, name: &str, subject: &str) {
    if let Err(err) = result {
        error!(op = name, subject = %subject, error = %err, "kafka control call failed");
    }
}

/// Decide the fate of the original offset after attempting the retry/dead-letter produce, given
/// whether that produce durably succeeded. Pure, so the preserve policy is unit-testable without a
/// broker (mirroring the broker-agnostic [`disposition`](crate::messaging::disposition) and the
/// RabbitMQ `dead_letter_disposition`): the original is safe to [`Disposition::Ack`] (commit,
/// removing it from redelivery) only once the record is durably on its retry/dead-letter topic; if
/// the produce failed, PRESERVE it with [`Disposition::Redeliver`] (leave the offset uncommitted) so
/// it is redelivered and never dropped.
fn commit_after_produce(produce_ok: bool) -> Disposition {
    if produce_ok {
        Disposition::Ack
    } else {
        Disposition::Redeliver
    }
}

/// Sanitize `subject` to a legal topic, replacing every non-alphanumeric character with `_` (the
/// same rule the NATS durable name uses), to which the `.retry`/`.dlq` suffixes append a legal dot.
fn topic_name(subject: &str) -> String {
    subject
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// The base topic a record belongs to: `<topic>.retry` is a retried delivery of `<topic>`, so the
/// retry suffix is stripped to find the base handler. The `.dlq` topic is terminal (not consumed),
/// so it is not stripped.
fn base_topic(topic: &str) -> String {
    topic
        .strip_suffix(RETRY_SUFFIX)
        .unwrap_or(topic)
        .to_string()
}

/// The dead-letter destination for `base`: the shared override when set and non-empty, otherwise the
/// per-topic `<base>.dlq` sibling.
fn resolve_dlq(dlq_topic: Option<&str>, base: &str) -> String {
    match dlq_topic {
        Some(topic) if !topic.is_empty() => topic.to_string(),
        _ => format!("{base}{DLQ_SUFFIX}"),
    }
}

/// Recover the original published subject from the `keel-subject` header, falling back to the
/// (sanitized) topic base when the header is absent (e.g. a record published by a non-keel producer).
/// Pure, so the subject-restoration contract is unit-testable without a broker: because the subject
/// -> topic transform is lossy, this is what lets the delivered [`InboundMessage::subject`] equal the
/// published subject rather than the lossy topic name (parity with NATS/RabbitMQ, where the subject
/// round-trips as the routing key).
fn inbound_subject(headers: &HashMap<String, String>, topic_base: &str) -> String {
    headers
        .get(SUBJECT_HEADER)
        .cloned()
        .unwrap_or_else(|| topic_base.to_string())
}

/// Read the redelivery count from the `keel-delivery-count` header; absent or unparsable -> 0 (the
/// first delivery). `dispatch` adds one to get the 1-based attempt count.
fn delivery_count(headers: &HashMap<String, String>) -> i64 {
    headers
        .get(DELIVERY_COUNT_HEADER)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
}

/// Lift the (UTF-8) record headers off a delivery into a plain string map (the shape the shared
/// trace-context extractor and the delivery-count reader consume). Non-UTF-8 header values are
/// skipped, exactly as the RabbitMQ adapter skips non-scalar AMQP values.
fn headers_to_map(headers: Option<&BorrowedHeaders>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(headers) = headers {
        for header in headers.iter() {
            if let Some(value) = header.value {
                if let Ok(text) = std::str::from_utf8(value) {
                    map.insert(header.key.to_string(), text.to_string());
                }
            }
        }
    }
    map
}

/// Build `OwnedHeaders` from a string map (used on publish, after trace-context injection).
fn map_to_headers(map: &HashMap<String, String>) -> OwnedHeaders {
    let mut owned = OwnedHeaders::new();
    for (key, value) in map {
        owned = owned.insert(Header {
            key,
            value: Some(value.as_bytes()),
        });
    }
    owned
}

/// Copy the record's headers onto a retry record, preserving every header (trace context included)
/// and stamping the incremented delivery count so the next delivery sees it.
fn headers_with_delivery_count(src: Option<&BorrowedHeaders>, count: i64) -> OwnedHeaders {
    let count = count.to_string();
    let mut owned = OwnedHeaders::new();
    let mut stamped = false;
    if let Some(headers) = src {
        for header in headers.iter() {
            if header.key == DELIVERY_COUNT_HEADER {
                owned = owned.insert(Header {
                    key: DELIVERY_COUNT_HEADER,
                    value: Some(count.as_bytes()),
                });
                stamped = true;
            } else {
                owned = owned.insert(header);
            }
        }
    }
    if !stamped {
        owned = owned.insert(Header {
            key: DELIVERY_COUNT_HEADER,
            value: Some(count.as_bytes()),
        });
    }
    owned
}

/// Copy the record's headers verbatim onto a dead-letter record, so the dead-lettered record is a
/// faithful copy of what failed (its original delivery count included).
fn clone_headers(src: Option<&BorrowedHeaders>) -> OwnedHeaders {
    let mut owned = OwnedHeaders::new();
    if let Some(headers) = src {
        for header in headers.iter() {
            owned = owned.insert(header);
        }
    }
    owned
}

/// Inject the current trace context (W3C `traceparent`/`tracestate`) into the header map, taken from
/// the active `tracing` span. With no active span / no tracer installed this is a no-op, exactly like
/// the NATS and RabbitMQ adapters.
fn inject_trace_context(map: &mut HashMap<String, String>) {
    let cx = tracing::Span::current().context();
    let mut injector = MapInjector(map);
    TraceContextPropagator::new().inject_context(&cx, &mut injector);
}

/// Injects W3C trace headers into the string header map that becomes the record's headers.
struct MapInjector<'a>(&'a mut HashMap<String, String>);

impl Injector for MapInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        self.0.insert(key.to_string(), value);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        base_topic, commit_after_produce, delivery_count, inbound_subject, resolve_dlq, split_csv,
        topic_name, KafkaConfig, DELIVERY_COUNT_HEADER, SUBJECT_HEADER,
    };
    use crate::messaging::{disposition, extract_trace_context, Disposition};
    use opentelemetry::trace::TraceContextExt;
    use std::collections::HashMap;

    #[test]
    fn config_defaults_match_the_adr_policy() {
        let config = KafkaConfig::new(vec!["localhost:9092".to_string()]);
        assert_eq!(config.topics, vec!["keel".to_string()]);
        assert_eq!(config.group_id, "keel");
        assert_eq!(config.dlq_topic, None);
        assert_eq!(config.max_deliver, 5);
    }

    #[test]
    fn split_csv_trims_and_drops_empty_entries() {
        assert_eq!(
            split_csv("a:9092, b:9092 ,, c:9092"),
            vec![
                "a:9092".to_string(),
                "b:9092".to_string(),
                "c:9092".to_string()
            ],
        );
        assert!(split_csv("   ").is_empty());
    }

    #[test]
    fn topic_name_sanitizes_non_alphanumeric_like_the_nats_durable_name() {
        // Subject tokens (`.`) and wildcards must not leak into the topic; the shared sanitizer rule.
        assert_eq!(topic_name("orders.created"), "orders_created");
        assert_eq!(topic_name("a.b.*"), "a_b__");
        // Stable across calls for the same subject.
        assert_eq!(topic_name("events"), topic_name("events"));
    }

    #[test]
    fn base_topic_strips_only_the_retry_suffix() {
        // A retry record routes back to its base handler.
        assert_eq!(base_topic("keel.retry"), "keel");
        assert_eq!(base_topic("orders_created.retry"), "orders_created");
        // A base topic is unchanged.
        assert_eq!(base_topic("keel"), "keel");
        // The dead-letter topic is terminal (never consumed), so it is not treated as a base.
        assert_eq!(base_topic("keel.dlq"), "keel.dlq");
    }

    #[test]
    fn resolve_dlq_prefers_the_override_then_the_per_topic_sibling() {
        // No override -> the per-topic <base>.dlq sibling.
        assert_eq!(resolve_dlq(None, "orders"), "orders.dlq");
        // A shared override wins.
        assert_eq!(resolve_dlq(Some("shared.dlq"), "orders"), "shared.dlq");
        // An empty override is ignored (falls back to the per-topic sibling).
        assert_eq!(resolve_dlq(Some(""), "orders"), "orders.dlq");
    }

    #[test]
    fn inbound_subject_restores_the_original_subject_from_the_header_else_the_topic() {
        // The subject -> topic transform is lossy (keel.test.events -> keel_test_events), so the
        // consume path must restore the ORIGINAL subject from the keel-subject header: the delivered
        // subject equals the published subject, not the sanitized topic.
        let mut headers = HashMap::new();
        headers.insert(SUBJECT_HEADER.to_string(), "keel.test.events".to_string());
        assert_eq!(
            inbound_subject(&headers, "keel_test_events"),
            "keel.test.events",
        );
        // Absent header (e.g. a non-keel producer) -> fall back to the topic base.
        assert_eq!(
            inbound_subject(&HashMap::new(), "keel_test_events"),
            "keel_test_events",
        );
    }

    #[test]
    fn delivery_count_reads_the_keel_header_absent_or_unparsable_is_zero() {
        let mut headers = HashMap::new();
        headers.insert(DELIVERY_COUNT_HEADER.to_string(), "3".to_string());
        assert_eq!(delivery_count(&headers), 3);
        // Absent -> 0 (first delivery).
        assert_eq!(delivery_count(&HashMap::new()), 0);
        // Unparsable -> 0.
        let mut garbage = HashMap::new();
        garbage.insert(
            DELIVERY_COUNT_HEADER.to_string(),
            "not-a-number".to_string(),
        );
        assert_eq!(delivery_count(&garbage), 0);
    }

    #[test]
    fn disposition_maps_delivery_count_to_ack_retry_dead_letter() {
        // The adapter computes num_delivered = keel-delivery-count + 1, then reuses the shared policy.
        let cap = 5;
        // Success acks regardless of count.
        assert_eq!(disposition(true, 1, cap), Disposition::Ack);
        // First failure (count 0 -> delivery 1) retries.
        assert_eq!(disposition(false, 1, cap), Disposition::Redeliver);
        // Just under the cap still retries (count 3 -> delivery 4).
        assert_eq!(disposition(false, 4, cap), Disposition::Redeliver);
        // At the cap (count 4 -> delivery 5) dead-letters.
        assert_eq!(disposition(false, 5, cap), Disposition::DeadLetter);
        // Beyond the cap dead-letters.
        assert_eq!(disposition(false, 6, cap), Disposition::DeadLetter);
    }

    #[test]
    fn dead_letters_at_the_fifth_attempt_given_the_header_count() {
        // The 5th delivery is keel-delivery-count == 4 (+1 = 5), which dead-letters at the default cap.
        let mut fifth = HashMap::new();
        fifth.insert(DELIVERY_COUNT_HEADER.to_string(), "4".to_string());
        let num_delivered = delivery_count(&fifth) + 1;
        assert_eq!(num_delivered, 5);
        assert_eq!(
            disposition(false, num_delivered, 5),
            Disposition::DeadLetter
        );

        // The 4th delivery (count 3 -> delivery 4) still retries, so the cap is exactly five attempts.
        let mut fourth = HashMap::new();
        fourth.insert(DELIVERY_COUNT_HEADER.to_string(), "3".to_string());
        assert_eq!(
            disposition(false, delivery_count(&fourth) + 1, 5),
            Disposition::Redeliver,
        );
    }

    #[test]
    fn produce_failure_preserves_the_offset_and_success_commits() {
        // commit_after_produce is the pure produce-then-commit-vs-preserve decision: commit only once
        // the record has a home on the retry/dead-letter topic.
        assert_eq!(commit_after_produce(true), Disposition::Ack);
        // A failed re-produce must PRESERVE the original (leave the offset uncommitted for
        // redelivery), never commit-and-drop, so a record is never lost to a produce outage
        // (ADR-0025 parity with the RabbitMQ dead-letter preserve policy).
        assert_eq!(commit_after_produce(false), Disposition::Redeliver);
    }

    #[test]
    fn extract_trace_context_reads_a_traceparent_from_record_headers() {
        let mut headers = HashMap::new();
        headers.insert(
            "traceparent".to_string(),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_string(),
        );
        let cx = extract_trace_context(&headers);
        let span = cx.span();
        let span_context = span.span_context();
        assert!(span_context.is_valid());
        assert_eq!(
            span_context.trace_id().to_string(),
            "4bf92f3577b34da6a3ce929d0e0e4736",
        );
    }

    #[test]
    fn extract_trace_context_without_a_traceparent_is_an_invalid_parent() {
        let cx = extract_trace_context(&HashMap::new());
        assert!(!cx.span().span_context().is_valid());
    }
}
