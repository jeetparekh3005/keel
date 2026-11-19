//! RabbitMQ `MessageBus` adapter over AMQP 0-9-1 (ADR-0025), parity with the NATS JetStream
//! adapter in [`crate::messaging`].
//!
//! Implements the shared [`MessageBus`] port with durable, manual-ack, at-least-once
//! delivery, mapping the one delivery contract onto RabbitMQ primitives: a durable **topic
//! exchange** with the message `subject` as the routing key, a durable **queue** bound to the
//! configured subjects, and manual acknowledgement. The nak-vs-dead-letter decision reuses the
//! broker-agnostic [`disposition`](crate::messaging::disposition) policy from the NATS adapter,
//! so the two buses behave identically: ack on handler success; `basic.nack(requeue=true)` while
//! the delivery count is below the cap; at the cap publish the message to a **dead-letter
//! exchange** and ack the original only once that publish has durably succeeded, always logging
//! the terminate. Dead-lettering is a durability operation: if the DLX publish fails the original
//! is preserved (`basic.nack(requeue=true)`, never acked-and-dropped) so no message is lost. A
//! failed ack/nack is logged, never raised, so a control-plane hiccup cannot kill the consume loop.
//!
//! The redelivery count rides in the AMQP `x-delivery-count` header (populated by quorum queues,
//! which this adapter declares) with a `keel-delivery-count` fallback; trace context (W3C
//! `traceparent`/`tracestate`) rides in AMQP headers, injected on publish and re-attached around
//! each handler via the same OpenTelemetry propagator the NATS adapter uses.
//!
//! Gated behind the `rabbitmq` feature (it pulls in `lapin`); the default core build stays
//! broker-free, exactly like the `nats` feature.

use std::collections::HashMap;

use futures::StreamExt;
use lapin::options::{
    BasicAckOptions, BasicConsumeOptions, BasicNackOptions, BasicPublishOptions, BasicQosOptions,
    ConfirmSelectOptions, ExchangeDeclareOptions, QueueBindOptions, QueueDeclareOptions,
};
use lapin::types::{AMQPValue, FieldTable};
use lapin::{BasicProperties, Channel, Connection, ConnectionProperties, ExchangeKind};
use opentelemetry::propagation::{Injector, TextMapPropagator};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use tracing::{error, warn, Instrument};
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::messaging::{
    disposition, extract_trace_context, Disposition, InboundMessage, MessageBus, MessageHandler,
    MessagePublisher, MessagingError,
};

/// AMQP persistent delivery mode (`delivery-mode = 2`): the broker writes the message to disk so
/// it survives a restart, matching the durable guarantee the NATS JetStream stream gives.
const PERSISTENT: u8 = 2;

/// Delivery policy and topology for a [`RabbitMqMessageBus`]. Defaults mirror ADR-0025:
/// exchange/queue `keel`, dead-letter exchange `keel.dlx`, subjects `keel.#`, `max_deliver = 5`,
/// and a consumer prefetch of 256 (the NATS `max_ack_pending`).
#[derive(Debug, Clone)]
pub struct RabbitMqConfig {
    /// AMQP server URL (e.g. `amqp://guest:guest@localhost:5672/`).
    pub url: String,
    /// Durable topic exchange messages are published to (`KEEL_RABBITMQ_EXCHANGE`).
    pub exchange: String,
    /// Durable queue bound to the subjects and consumed (`KEEL_RABBITMQ_QUEUE`).
    pub queue: String,
    /// Dead-letter exchange a poison message is published to at the cap (`KEEL_RABBITMQ_DLX`).
    pub dlx: String,
    /// Routing-key patterns the queue is bound to (`KEEL_RABBITMQ_SUBJECTS`).
    pub subjects: Vec<String>,
    /// Redelivery cap before a failing message is dead-lettered.
    pub max_deliver: i64,
    /// Consumer prefetch (`basic.qos`): the upper bound on unacked in-flight messages.
    pub prefetch: u16,
}

impl RabbitMqConfig {
    /// Build a config with the ADR-0025 default topology and delivery policy for the given server.
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            exchange: "keel".to_string(),
            queue: "keel".to_string(),
            dlx: "keel.dlx".to_string(),
            subjects: vec!["keel.#".to_string()],
            max_deliver: 5,
            prefetch: 256,
        }
    }

    /// Build a config from the environment, returning `None` when the `KEEL_RABBITMQ_URL` gate is
    /// unset or empty (so the default, broker-free deployment never constructs a RabbitMQ bus),
    /// mirroring [`KafkaConfig::from_env`](crate::kafka::KafkaConfig::from_env). The topology keys
    /// default per ADR-0025: `KEEL_RABBITMQ_EXCHANGE`/`KEEL_RABBITMQ_QUEUE` to `keel`,
    /// `KEEL_RABBITMQ_DLX` to `keel.dlx`, and `KEEL_RABBITMQ_SUBJECTS` (comma-separated) to
    /// `keel.#`.
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let mut config = Self::new(env_var("KEEL_RABBITMQ_URL")?);
        if let Some(exchange) = env_var("KEEL_RABBITMQ_EXCHANGE") {
            config.exchange = exchange;
        }
        if let Some(queue) = env_var("KEEL_RABBITMQ_QUEUE") {
            config.queue = queue;
        }
        if let Some(dlx) = env_var("KEEL_RABBITMQ_DLX") {
            config.dlx = dlx;
        }
        if let Some(subjects) = env_var("KEEL_RABBITMQ_SUBJECTS").map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        }) {
            if !subjects.is_empty() {
                config.subjects = subjects;
            }
        }
        Some(config)
    }
}

/// Read an environment variable, treating empty or whitespace-only as unset and trimming
/// surrounding whitespace - the gating-var convention shared with the bus selector.
fn env_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// A [`MessageBus`] backed by RabbitMQ (AMQP 0-9-1) for durable at-least-once delivery.
///
/// Constructed already connected (see [`RabbitMqMessageBus::connect`]): the exchange, the
/// dead-letter exchange, the durable queue, and its subject bindings are all ensured at
/// construction, so there is no "connect before use" footgun and every `publish` / `subscribe`
/// runs against a live channel.
pub struct RabbitMqMessageBus {
    connection: Connection,
    /// The publish channel, with publisher confirms enabled so `publish` can await durable
    /// persistence (the AMQP analogue of awaiting the JetStream publish ack).
    channel: Channel,
    exchange: String,
    dlx: String,
    queue: String,
    max_deliver: i64,
    prefetch: u16,
}

impl RabbitMqMessageBus {
    /// Connect to the server, declare the topic exchange, the dead-letter exchange, and the
    /// durable queue bound to the configured subjects, returning a ready-to-use bus.
    ///
    /// The queue is declared as a **quorum** queue so the broker maintains a per-message
    /// `x-delivery-count`, which the dispatch loop reads to enforce the redelivery cap.
    ///
    /// # Errors
    /// Returns [`MessagingError::Connect`] if the server is unreachable or the topology cannot be
    /// ensured.
    pub async fn connect(config: RabbitMqConfig) -> Result<Self, MessagingError> {
        let connection = Connection::connect(&config.url, ConnectionProperties::default())
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))?;
        let channel = connection
            .create_channel()
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))?;
        // Publisher confirms make publish reliable: basic_publish's PublisherConfirm resolves when
        // the broker has accepted (and, for a routed persistent message, persisted) it.
        channel
            .confirm_select(ConfirmSelectOptions::default())
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))?;

        let durable = ExchangeDeclareOptions {
            durable: true,
            ..Default::default()
        };
        channel
            .exchange_declare(
                config.exchange.as_str().into(),
                ExchangeKind::Topic,
                durable,
                FieldTable::default(),
            )
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))?;
        // The dead-letter exchange is a sibling topic exchange; terminated messages are published
        // to it with their original routing key so a DLX-bound queue can triage by subject.
        channel
            .exchange_declare(
                config.dlx.as_str().into(),
                ExchangeKind::Topic,
                durable,
                FieldTable::default(),
            )
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))?;

        let mut queue_args = FieldTable::default();
        // Quorum queues expose x-delivery-count (ADR-0025), the portable per-message redelivery
        // counter the delivery cap relies on; a classic queue would not populate it.
        queue_args.insert(
            "x-queue-type".into(),
            AMQPValue::LongString("quorum".into()),
        );
        channel
            .queue_declare(
                config.queue.as_str().into(),
                QueueDeclareOptions {
                    durable: true,
                    ..Default::default()
                },
                queue_args,
            )
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))?;
        for subject in &config.subjects {
            channel
                .queue_bind(
                    config.queue.as_str().into(),
                    config.exchange.as_str().into(),
                    subject.as_str().into(),
                    QueueBindOptions::default(),
                    FieldTable::default(),
                )
                .await
                .map_err(|err| MessagingError::Connect(err.to_string()))?;
        }

        Ok(Self {
            connection,
            channel,
            exchange: config.exchange,
            dlx: config.dlx,
            queue: config.queue,
            max_deliver: config.max_deliver,
            prefetch: config.prefetch,
        })
    }

    /// Close the connection (call at shutdown).
    ///
    /// # Errors
    /// Returns [`MessagingError::Connect`] if closing the connection fails.
    pub async fn close(self) -> Result<(), MessagingError> {
        self.connection
            .close(200, "keel shutdown".into())
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))
    }
}

#[async_trait::async_trait]
impl MessagePublisher for RabbitMqMessageBus {
    async fn publish(
        &self,
        subject: &str,
        payload: &[u8],
        headers: &HashMap<String, String>,
    ) -> Result<(), MessagingError> {
        let mut table = FieldTable::default();
        for (key, value) in headers {
            table.insert(
                key.as_str().into(),
                AMQPValue::LongString(value.clone().into()),
            );
        }
        inject_trace_context(&mut table);
        let properties = BasicProperties::default()
            .with_headers(table)
            .with_delivery_mode(PERSISTENT);
        // The first await hands the publish to the channel; the returned PublisherConfirm future
        // resolves when the broker acknowledges it. Awaiting both is what makes publish reliable.
        self.channel
            .basic_publish(
                self.exchange.as_str().into(),
                subject.into(),
                BasicPublishOptions::default(),
                payload,
                properties,
            )
            .await
            .map_err(|err| MessagingError::Publish(err.to_string()))?
            .await
            .map_err(|err| MessagingError::Publish(err.to_string()))?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl MessageBus for RabbitMqMessageBus {
    async fn subscribe(
        &self,
        subject: &str,
        handler: MessageHandler,
    ) -> Result<(), MessagingError> {
        // A dedicated consume channel so the prefetch window and consumer lifecycle are isolated
        // from the publish channel (and from any other subscription).
        let channel = self
            .connection
            .create_channel()
            .await
            .map_err(|err| MessagingError::Subscribe(err.to_string()))?;
        channel
            .basic_qos(self.prefetch, BasicQosOptions::default())
            .await
            .map_err(|err| MessagingError::Subscribe(err.to_string()))?;
        // Bind this subject to the shared queue (idempotent), so a subscribe for a subject outside
        // the config's default bindings still receives it.
        channel
            .queue_bind(
                self.queue.as_str().into(),
                self.exchange.as_str().into(),
                subject.into(),
                QueueBindOptions::default(),
                FieldTable::default(),
            )
            .await
            .map_err(|err| MessagingError::Subscribe(err.to_string()))?;
        let mut consumer = channel
            .basic_consume(
                self.queue.as_str().into(),
                consumer_tag(subject).into(),
                // no_ack defaults to false: manual acknowledgement, the at-least-once contract.
                BasicConsumeOptions::default(),
                FieldTable::default(),
            )
            .await
            .map_err(|err| MessagingError::Subscribe(err.to_string()))?;

        let dlx = self.dlx.clone();
        let queue = self.queue.clone();
        let max_deliver = self.max_deliver;
        // The consume channel is cloned into the task to publish dead-letters; cloning a lapin
        // Channel shares the underlying channel, it does not open a new one.
        let dlx_channel = channel.clone();
        // One bad message must never kill the loop, so dispatch never returns an error; a
        // transport-level stream error is logged and polling continues.
        tokio::spawn(async move {
            while let Some(next) = consumer.next().await {
                match next {
                    Ok(delivery) => {
                        dispatch(&dlx_channel, delivery, &handler, &dlx, max_deliver).await;
                    }
                    Err(err) => {
                        warn!(error = %err, queue = %queue, "rabbitmq consumer stream error");
                    }
                }
            }
        });
        Ok(())
    }
}

/// Dispatch one delivered message to `handler` under its propagated trace context, then
/// ack / nak / dead-letter based on the outcome. Never returns an error: control-plane failures
/// are logged, not propagated, so the subscription loop keeps running.
async fn dispatch(
    channel: &Channel,
    delivery: lapin::message::Delivery,
    handler: &MessageHandler,
    dlx: &str,
    max_deliver: i64,
) {
    let headers = fields_to_string_map(delivery.properties.headers());
    let subject = delivery.routing_key.as_str().to_string();
    let inbound = InboundMessage {
        subject: subject.clone(),
        payload: delivery.data.clone(),
        headers: headers.clone(),
    };

    // A consume span parented on the producer's remote trace, so handler log lines and any nested
    // spans link back to the publish side (the cross-broker trace link).
    let span = tracing::info_span!(
        "messaging.consume",
        messaging.system = "rabbitmq",
        messaging.destination = %subject,
    );
    // Errs only when no OpenTelemetry subscriber is installed (export off), the same regime in
    // which spans are no-ops here; ignore rather than log on every message.
    let _ = span.set_parent(extract_trace_context(&headers));

    let outcome = handler(inbound).instrument(span).await;
    // x-delivery-count counts prior failed attempts (0 on first delivery), so +1 gives the
    // delivery number, matching the NATS `delivered` count the shared policy expects.
    let num_delivered = delivery_count(&headers) + 1;

    match disposition(outcome.is_ok(), num_delivered, max_deliver) {
        Disposition::Ack => {
            control(
                delivery.acker.ack(BasicAckOptions::default()),
                "ack",
                &subject,
            )
            .await;
        }
        Disposition::Redeliver => {
            if let Err(err) = &outcome {
                warn!(
                    subject = %subject,
                    num_delivered,
                    error = %err,
                    "message handler failed; scheduling redelivery",
                );
            }
            control(
                delivery.acker.nack(BasicNackOptions {
                    multiple: false,
                    requeue: true,
                }),
                "nack",
                &subject,
            )
            .await;
        }
        Disposition::DeadLetter => {
            if let Err(err) = &outcome {
                // Dead-lettering drops the message from redelivery; this must never be silent, so
                // log the poison message's handler error at error.
                error!(
                    subject = %subject,
                    dlx = %dlx,
                    num_delivered,
                    max_deliver,
                    error = %err,
                    "message terminated after exhausting delivery attempts",
                );
            }
            // Dead-lettering is a durability operation: publish the original payload + headers to
            // the dead-letter exchange, and ack the original (removing it from the queue) only once
            // that publish has durably succeeded. If the DLX publish fails, PRESERVE the message -
            // nack(requeue=true) so it is retried, never ack-and-drop - so a poison message is
            // never lost to a DLX outage. The requeue loop self-heals when the DLX recovers, and a
            // permanently-broken DLX is a loud, alertable misconfiguration rather than silent data
            // loss. Matches the Python and Java adapters (ADR-0025). A failed DLX publish is logged,
            // not raised, so the consume loop keeps running.
            let dlx_result = publish_dead_letter(
                channel,
                dlx,
                &subject,
                &delivery.data,
                delivery.properties.headers(),
            )
            .await;
            if let Err(err) = &dlx_result {
                error!(subject = %subject, dlx = %dlx, error = %err, "failed to publish to dead-letter exchange; preserving message for redelivery");
            }
            match dead_letter_disposition(dlx_result.is_ok()) {
                Disposition::Ack => {
                    control(
                        delivery.acker.ack(BasicAckOptions::default()),
                        "ack (after dead-letter)",
                        &subject,
                    )
                    .await;
                }
                _ => {
                    control(
                        delivery.acker.nack(BasicNackOptions {
                            multiple: false,
                            requeue: true,
                        }),
                        "nack (dead-letter publish failed)",
                        &subject,
                    )
                    .await;
                }
            }
        }
    }
}

/// Publish a terminated message to the dead-letter exchange with its original routing key and
/// headers (so the DLX carries the same trace context and app headers as the original).
async fn publish_dead_letter(
    channel: &Channel,
    dlx: &str,
    subject: &str,
    payload: &[u8],
    headers: &Option<FieldTable>,
) -> Result<(), MessagingError> {
    let properties = BasicProperties::default().with_delivery_mode(PERSISTENT);
    let properties = match headers {
        Some(table) => properties.with_headers(table.clone()),
        None => properties,
    };
    channel
        .basic_publish(
            dlx.into(),
            subject.into(),
            BasicPublishOptions::default(),
            payload,
            properties,
        )
        .await
        .map_err(|err| MessagingError::Publish(err.to_string()))?
        .await
        .map_err(|err| MessagingError::Publish(err.to_string()))?;
    Ok(())
}

/// Decide the fate of the original delivery after attempting the dead-letter publish, given
/// whether that publish durably succeeded. Pure, so the preserve policy is unit-testable without a
/// broker (mirroring the broker-agnostic [`disposition`](crate::messaging::disposition)):
/// dead-lettering is a durability operation, so the original is safe to [`Disposition::Ack`]
/// (remove from the queue) only once it is durably on the dead-letter exchange; if the DLX publish
/// failed, PRESERVE it with [`Disposition::Redeliver`] (nack requeue=true) so it is retried and
/// never dropped. Matches the Python and Java adapters (ADR-0025).
fn dead_letter_disposition(dlx_publish_ok: bool) -> Disposition {
    if dlx_publish_ok {
        Disposition::Ack
    } else {
        Disposition::Redeliver
    }
}

/// Await an ack/nack call, logging (not raising) a control-plane failure so a failed
/// acknowledgement surfaces instead of vanishing into silent redelivery anomalies.
async fn control(
    op: impl std::future::Future<Output = lapin::Result<bool>>,
    name: &str,
    subject: &str,
) {
    if let Err(err) = op.await {
        error!(op = name, subject = %subject, error = %err, "rabbitmq control call failed");
    }
}

/// Derive a stable, broker-safe consumer tag from a subject, mirroring the NATS adapter's
/// `durable_name`: a predictable `keel_<sanitized>` identifier so a resubscribe reuses the tag.
fn consumer_tag(subject: &str) -> String {
    let safe: String = subject
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("keel_{safe}")
}

/// Read the redelivery count from the AMQP `x-delivery-count` header (populated by quorum queues)
/// with a portable `keel-delivery-count` fallback. Absent or unparsable -> 0 (first delivery).
fn delivery_count(headers: &HashMap<String, String>) -> i64 {
    headers
        .get("x-delivery-count")
        .or_else(|| headers.get("keel-delivery-count"))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
}

/// Lift the string-valued AMQP headers off a delivery into a plain map (the shape the shared
/// trace-context extractor and the delivery-count reader consume). Non-stringifiable values
/// (arrays, tables, void) are skipped; integer headers like `x-delivery-count` are rendered in
/// decimal so the count reader can parse them.
fn fields_to_string_map(headers: &Option<FieldTable>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(table) = headers {
        for (key, value) in table.inner() {
            if let Some(rendered) = amqp_value_to_string(value) {
                map.insert(key.as_str().to_string(), rendered);
            }
        }
    }
    map
}

/// Render a scalar AMQP header value as a string, or `None` for a non-scalar (array/table/void)
/// value that has no meaningful flat representation.
fn amqp_value_to_string(value: &AMQPValue) -> Option<String> {
    match value {
        AMQPValue::LongString(string) => Some(string.to_string()),
        AMQPValue::ShortString(string) => Some(string.as_str().to_string()),
        AMQPValue::Boolean(boolean) => Some(boolean.to_string()),
        AMQPValue::ShortShortInt(number) => Some(number.to_string()),
        AMQPValue::ShortShortUInt(number) => Some(number.to_string()),
        AMQPValue::ShortInt(number) => Some(number.to_string()),
        AMQPValue::ShortUInt(number) => Some(number.to_string()),
        AMQPValue::LongInt(number) => Some(number.to_string()),
        AMQPValue::LongUInt(number) => Some(number.to_string()),
        AMQPValue::LongLongInt(number) => Some(number.to_string()),
        AMQPValue::Timestamp(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Inject the current trace context (W3C `traceparent`/`tracestate`) into an AMQP header table,
/// taken from the active `tracing` span. With no active span / no tracer installed this is a
/// no-op, exactly like the NATS adapter.
fn inject_trace_context(table: &mut FieldTable) {
    let cx = tracing::Span::current().context();
    let mut injector = FieldTableInjector(table);
    TraceContextPropagator::new().inject_context(&cx, &mut injector);
}

/// Injects W3C trace headers into an AMQP [`FieldTable`] as long-string values.
struct FieldTableInjector<'a>(&'a mut FieldTable);

impl Injector for FieldTableInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        self.0
            .insert(key.into(), AMQPValue::LongString(value.into()));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        amqp_value_to_string, consumer_tag, dead_letter_disposition, delivery_count,
        fields_to_string_map, RabbitMqConfig,
    };
    use crate::messaging::{disposition, extract_trace_context, Disposition};
    use lapin::types::{AMQPValue, FieldTable};
    use opentelemetry::trace::TraceContextExt;
    use std::collections::HashMap;

    #[test]
    fn config_defaults_match_the_adr_topology() {
        let config = RabbitMqConfig::new("amqp://localhost:5672/");
        assert_eq!(config.exchange, "keel");
        assert_eq!(config.queue, "keel");
        assert_eq!(config.dlx, "keel.dlx");
        assert_eq!(config.subjects, vec!["keel.#".to_string()]);
        assert_eq!(config.max_deliver, 5);
        assert_eq!(config.prefetch, 256);
    }

    #[test]
    fn consumer_tag_is_broker_safe_and_stable() {
        // Subject tokens (`.`) and wildcards must not leak into the consumer tag.
        assert_eq!(consumer_tag("orders.created"), "keel_orders_created");
        assert_eq!(consumer_tag("a.b.*"), "keel_a_b__");
        // Stable across calls for the same subject (a resubscribe reuses the tag).
        assert_eq!(consumer_tag("events"), consumer_tag("events"));
    }

    #[test]
    fn delivery_count_reads_x_delivery_count_first_then_the_keel_fallback() {
        // The AMQP quorum-queue header wins when present.
        let mut headers = HashMap::new();
        headers.insert("x-delivery-count".to_string(), "3".to_string());
        headers.insert("keel-delivery-count".to_string(), "9".to_string());
        assert_eq!(delivery_count(&headers), 3);

        // Falls back to the portable header when x-delivery-count is absent.
        let mut fallback = HashMap::new();
        fallback.insert("keel-delivery-count".to_string(), "4".to_string());
        assert_eq!(delivery_count(&fallback), 4);

        // Absent or unparsable -> 0 (treated as the first delivery).
        assert_eq!(delivery_count(&HashMap::new()), 0);
        let mut garbage = HashMap::new();
        garbage.insert("x-delivery-count".to_string(), "not-a-number".to_string());
        assert_eq!(delivery_count(&garbage), 0);
    }

    #[test]
    fn disposition_maps_delivery_count_to_ack_nack_dead_letter() {
        // The adapter computes num_delivered = x-delivery-count + 1, then reuses the shared policy.
        let cap = 5;
        // Success acks regardless of count.
        assert_eq!(disposition(true, 1, cap), Disposition::Ack);
        // First failure (x-delivery-count 0 -> delivery 1) redelivers.
        assert_eq!(disposition(false, 1, cap), Disposition::Redeliver);
        // Just under the cap still redelivers (x-delivery-count 3 -> delivery 4).
        assert_eq!(disposition(false, 4, cap), Disposition::Redeliver);
        // At the cap (x-delivery-count 4 -> delivery 5) dead-letters.
        assert_eq!(disposition(false, 5, cap), Disposition::DeadLetter);
        // Beyond the cap dead-letters (x-delivery-count 9 -> delivery 10).
        assert_eq!(disposition(false, 10, cap), Disposition::DeadLetter);
    }

    #[test]
    fn dead_letter_preserves_the_message_when_the_dlx_publish_fails() {
        // Dead-lettering is a durability operation: the original is only safe to ack (remove from
        // the queue) once it is durably on the dead-letter exchange.
        assert_eq!(dead_letter_disposition(true), Disposition::Ack);
        // A failed DLX publish must PRESERVE the message - nack(requeue=true) for retry, never
        // ack-and-drop - so a poison message is never lost to a DLX outage (ADR-0025 parity with
        // the Python and Java adapters).
        assert_eq!(dead_letter_disposition(false), Disposition::Redeliver);
    }

    #[test]
    fn fields_to_string_map_renders_strings_and_integers_and_skips_non_scalars() {
        let mut table = FieldTable::default();
        table.insert(
            "traceparent".into(),
            AMQPValue::LongString("00-abc-01".into()),
        );
        table.insert("x-delivery-count".into(), AMQPValue::LongInt(3));
        table.insert("x-keel-app".into(), AMQPValue::LongString("ping".into()));
        // A non-scalar value is skipped rather than producing a debug string.
        table.insert(
            "nested".into(),
            AMQPValue::FieldTable(FieldTable::default()),
        );

        let map = fields_to_string_map(&Some(table));
        assert_eq!(
            map.get("traceparent").map(String::as_str),
            Some("00-abc-01")
        );
        assert_eq!(map.get("x-delivery-count").map(String::as_str), Some("3"));
        assert_eq!(map.get("x-keel-app").map(String::as_str), Some("ping"));
        assert!(!map.contains_key("nested"));

        // A None header table yields an empty map.
        assert!(fields_to_string_map(&None).is_empty());
    }

    #[test]
    fn amqp_value_to_string_handles_scalars_and_rejects_void() {
        assert_eq!(
            amqp_value_to_string(&AMQPValue::LongString("hi".into())),
            Some("hi".to_string()),
        );
        assert_eq!(
            amqp_value_to_string(&AMQPValue::LongLongInt(42)),
            Some("42".to_string()),
        );
        assert_eq!(amqp_value_to_string(&AMQPValue::Void), None);
    }

    #[test]
    fn extract_trace_context_reads_a_traceparent_lifted_off_amqp_headers() {
        // The full consume-side chain: AMQP header table -> string map -> remote trace context.
        let mut table = FieldTable::default();
        table.insert(
            "traceparent".into(),
            AMQPValue::LongString("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".into()),
        );
        let headers = fields_to_string_map(&Some(table));
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
