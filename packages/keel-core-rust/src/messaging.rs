//! The `MessageBus` port, its in-memory dev default, the fail-closed env selector, and the NATS
//! JetStream adapter (parity with the Python `keel-core[nats]` extra).
//!
//! The shared `MessageBus` port lives here - [`InboundMessage`], [`MessagePublisher`],
//! [`MessageBus`], [`MessagingError`], and the W3C trace-context helpers - alongside two things
//! that are always compiled so a broker-free service still resolves a working bus (ADR-0025
//! decision 3): the in-memory dev default [`InMemoryMessageBus`] and the fail-closed
//! [`message_bus_from_env`] selector (at most one of `KEEL_NATS_URL` / `KEEL_KAFKA_BROKERS` /
//! `KEEL_RABBITMQ_URL`; none yields the in-memory bus), mirroring
//! [`secret_provider_from_env`](crate::secret::secret_provider_from_env).
//!
//! The broker adapters are opt-in: [`NatsMessageBus`] here is gated behind `nats` (it pulls in
//! `async-nats`), Kafka lives in [`crate::kafka`] (`kafka`), and RabbitMQ in [`crate::rabbitmq`]
//! (`rabbitmq`); each reuses this port plus the pure `disposition` policy rather than redefining
//! the contract. The JetStream adapter gives durable, explicit-ack, at-least-once delivery: trace
//! context propagates through message headers so a consumer span links to the producer's trace,
//! and on handler failure the message is nak'd (redelivered) until `max_deliver`, then term'd and
//! logged at error, so a poison message neither loops forever nor is dropped silently. The default
//! core build stays broker-free, exactly like `pip install keel-core` omitting `nats-py` until you
//! ask for the `nats` extra.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use opentelemetry::propagation::{Extractor, Injector, TextMapPropagator};
use opentelemetry::Context as OtelContext;
use opentelemetry_sdk::propagation::TraceContextPropagator;
// The in-memory bus and the selector are always compiled (ADR-0025 dev default), so the
// trace-span bridge they use is an always-on import, not a broker-gated one.
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;

// NATS-specific imports. The shared port above compiles under either broker feature
// (`nats` or `rabbitmq`); the JetStream adapter below is `nats`-only.
#[cfg(feature = "nats")]
use std::time::Duration;

#[cfg(feature = "nats")]
use async_nats::jetstream::consumer::pull::Config as PullConfig;
#[cfg(feature = "nats")]
use async_nats::jetstream::consumer::AckPolicy;
#[cfg(feature = "nats")]
use async_nats::jetstream::message::{AckKind, Message};
#[cfg(feature = "nats")]
use async_nats::jetstream::stream::Config as StreamConfig;
#[cfg(feature = "nats")]
use async_nats::jetstream::Context as JetStreamContext;
#[cfg(feature = "nats")]
use async_nats::{Client, HeaderMap};
#[cfg(feature = "nats")]
use bytes::Bytes;
#[cfg(feature = "nats")]
use futures::StreamExt;
#[cfg(feature = "nats")]
use tracing::{error, warn};

/// A message delivered to a subscriber: subject, raw payload, and propagation headers.
#[derive(Debug, Clone)]
pub struct InboundMessage {
    /// The subject the message was published to.
    pub subject: String,
    /// The raw message body.
    pub payload: Vec<u8>,
    /// Message headers (carries the W3C `traceparent`/`tracestate` among any app headers).
    pub headers: HashMap<String, String>,
}

/// What a handler may return: unit on success, any boxed error on failure (a failure
/// triggers redelivery or, past the cap, dead-lettering).
pub type HandlerResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;

/// The future a [`MessageHandler`] produces.
pub type HandlerFuture = Pin<Box<dyn Future<Output = HandlerResult> + Send>>;

/// A subscriber callback: receives one [`InboundMessage`] and resolves to a
/// [`HandlerResult`]. `Arc`-wrapped so the dispatch loop can keep calling it.
pub type MessageHandler = Arc<dyn Fn(InboundMessage) -> HandlerFuture + Send + Sync>;

/// Failures surfaced by the bus itself (connecting, publishing, subscribing). Handler
/// failures are not errors here: they drive ack/nak/term inside the dispatch loop. Shared by
/// both broker adapters, so the wording is broker-neutral.
#[derive(Debug, thiserror::Error)]
pub enum MessagingError {
    /// Connecting to the broker or ensuring the stream/exchange topology failed.
    #[error("message bus connect failed: {0}")]
    Connect(String),
    /// Publishing (or awaiting the broker's publish acknowledgement) failed.
    #[error("message bus publish failed: {0}")]
    Publish(String),
    /// Creating the durable consumer or its message stream failed.
    #[error("message bus subscribe failed: {0}")]
    Subscribe(String),
}

/// Publishes events to a subject (the driven port's producer half).
#[async_trait::async_trait]
pub trait MessagePublisher: Send + Sync {
    /// Publish `payload` to `subject` with optional application `headers`. The current
    /// trace context is injected into the headers transparently.
    async fn publish(
        &self,
        subject: &str,
        payload: &[u8],
        headers: &HashMap<String, String>,
    ) -> Result<(), MessagingError>;
}

/// A publisher that also lets consumers subscribe to subjects (the full driven port).
#[async_trait::async_trait]
pub trait MessageBus: MessagePublisher {
    /// Register `handler` to receive messages published to `subject` via a durable,
    /// explicit-ack consumer. Returns once the background consumer is running.
    async fn subscribe(&self, subject: &str, handler: MessageHandler)
        -> Result<(), MessagingError>;
}

/// A process-local [`MessageBus`] for development and tests (ADR-0025 decision 3, the dev
/// default): `publish` dispatches synchronously and in-process to every handler subscribed to the
/// subject, with no broker, no durability, and no redelivery. Trace context is injected into the
/// message headers on publish and re-attached around each handler exactly as a real broker adapter
/// does, so handler spans and logs correlate to the publisher's trace. This is what
/// [`message_bus_from_env`] returns when no broker gating variable is set, mirroring the Python
/// `InMemoryMessageBus`.
#[derive(Clone, Default)]
pub struct InMemoryMessageBus {
    /// subject -> the handlers subscribed to it. Cloned out under the lock before dispatch so the
    /// lock is never held across a handler `await`.
    subscribers: Arc<Mutex<HashMap<String, Vec<MessageHandler>>>>,
}

impl InMemoryMessageBus {
    /// Create an empty in-memory bus.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl MessagePublisher for InMemoryMessageBus {
    async fn publish(
        &self,
        subject: &str,
        payload: &[u8],
        headers: &HashMap<String, String>,
    ) -> Result<(), MessagingError> {
        let mut carrier = headers.clone();
        inject_trace_context_into_map(&mut carrier);
        // Snapshot the handler list under the lock, then release it: a handler is async and must
        // never be awaited while the subscribers mutex is held.
        let handlers = {
            let guard = self
                .subscribers
                .lock()
                .expect("in-memory bus subscribers lock");
            guard.get(subject).cloned().unwrap_or_default()
        };
        for handler in handlers {
            let inbound = InboundMessage {
                subject: subject.to_string(),
                payload: payload.to_vec(),
                headers: carrier.clone(),
            };
            // A consume span parented on the publisher's trace, so handler log lines link back to
            // the publish side, mirroring the real broker adapters' consume span.
            let span = tracing::info_span!(
                "messaging.consume",
                messaging.system = "in_memory",
                messaging.destination = %subject,
            );
            let _ = span.set_parent(extract_trace_context(&carrier));
            if let Err(err) = handler(inbound).instrument(span).await {
                // The dev bus has no redelivery or dead-letter; surface a handler failure so a
                // broken subscriber is visible rather than silently swallowed.
                tracing::warn!(subject = %subject, error = %err, "in-memory message handler failed");
            }
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl MessageBus for InMemoryMessageBus {
    async fn subscribe(
        &self,
        subject: &str,
        handler: MessageHandler,
    ) -> Result<(), MessagingError> {
        self.subscribers
            .lock()
            .expect("in-memory bus subscribers lock")
            .entry(subject.to_string())
            .or_default()
            .push(handler);
        Ok(())
    }
}

/// Read an environment variable, treating empty or whitespace-only as unset and trimming
/// surrounding whitespace. This is the gating-var convention shared with the secret-provider
/// selector (`crate::secret::env_var`), so "set" means the same thing for both.
fn env_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Failure selecting or constructing the message bus (ADR-0025 decision 3, fail-closed
/// selection). Selection failures fail loudly at startup rather than silently falling through to
/// the in-memory dev bus, exactly like the [`SecretProviderError`](crate::secret::SecretProviderError)
/// selector.
#[derive(Debug, thiserror::Error)]
pub enum MessageBusError {
    /// More than one broker gating variable is set - an ambiguous misconfiguration.
    #[error(
        "multiple message bus backends configured: set at most one of KEEL_NATS_URL, KEEL_KAFKA_BROKERS, KEEL_RABBITMQ_URL"
    )]
    MultipleBackends,
    /// A broker's gating variable is set but that broker's cargo feature is not compiled into this
    /// build. Surfaced (not silently ignored) so configuration never falls through to the in-memory
    /// dev bus when a real broker was asked for. Never constructed in an all-brokers build, where
    /// every adapter is present.
    #[allow(dead_code)]
    #[error(
        "message bus backend {0} is configured but its cargo feature is not enabled in this build"
    )]
    BackendNotCompiled(&'static str),
    /// The selected broker adapter failed to connect/construct (bad config, unreachable broker).
    /// Only reachable when a broker feature is on; in the default (broker-free) build no branch
    /// attempts a connect, so the variant is compiled out there.
    #[cfg(any(feature = "nats", feature = "rabbitmq", feature = "kafka"))]
    #[error(transparent)]
    Connect(#[from] MessagingError),
}

/// Select the message bus fail-closed from the environment (ADR-0025 decision 3): at most one of
/// `KEEL_NATS_URL` (NATS JetStream), `KEEL_KAFKA_BROKERS` (Kafka), or `KEEL_RABBITMQ_URL`
/// (RabbitMQ) may be set; more than one is an ambiguous misconfiguration that fails. A gating var
/// whose adapter feature is not compiled in also fails (never a silent fall-through). None set
/// yields the in-memory [`InMemoryMessageBus`] dev default. Async because the broker adapters
/// connect asynchronously; boxed as `Arc<dyn MessageBus>` for the service composition root,
/// mirroring [`secret_provider_from_env`](crate::secret::secret_provider_from_env).
///
/// # Errors
/// Returns [`MessageBusError`] when more than one broker is configured, when a configured broker's
/// feature is not compiled in, or when the selected adapter cannot connect: the service fails to
/// start rather than silently running on the in-memory dev bus.
pub async fn message_bus_from_env() -> Result<Arc<dyn MessageBus>, MessageBusError> {
    let nats_set = env_var("KEEL_NATS_URL").is_some();
    let kafka_set = env_var("KEEL_KAFKA_BROKERS").is_some();
    let rabbitmq_set = env_var("KEEL_RABBITMQ_URL").is_some();

    if [nats_set, kafka_set, rabbitmq_set]
        .into_iter()
        .filter(|set| *set)
        .count()
        > 1
    {
        return Err(MessageBusError::MultipleBackends);
    }

    if nats_set {
        #[cfg(feature = "nats")]
        {
            let config = NatsConfig::from_env().ok_or_else(|| {
                MessagingError::Connect("KEEL_NATS_URL is set but empty".to_string())
            })?;
            return Ok(Arc::new(NatsMessageBus::connect(config).await?));
        }
        #[cfg(not(feature = "nats"))]
        {
            return Err(MessageBusError::BackendNotCompiled("KEEL_NATS_URL"));
        }
    }

    if kafka_set {
        #[cfg(feature = "kafka")]
        {
            let config = crate::kafka::KafkaConfig::from_env().ok_or_else(|| {
                MessagingError::Connect("KEEL_KAFKA_BROKERS is set but empty".to_string())
            })?;
            return Ok(Arc::new(
                crate::kafka::KafkaMessageBus::connect(config).await?,
            ));
        }
        #[cfg(not(feature = "kafka"))]
        {
            return Err(MessageBusError::BackendNotCompiled("KEEL_KAFKA_BROKERS"));
        }
    }

    if rabbitmq_set {
        #[cfg(feature = "rabbitmq")]
        {
            let config = crate::rabbitmq::RabbitMqConfig::from_env().ok_or_else(|| {
                MessagingError::Connect("KEEL_RABBITMQ_URL is set but empty".to_string())
            })?;
            return Ok(Arc::new(
                crate::rabbitmq::RabbitMqMessageBus::connect(config).await?,
            ));
        }
        #[cfg(not(feature = "rabbitmq"))]
        {
            return Err(MessageBusError::BackendNotCompiled("KEEL_RABBITMQ_URL"));
        }
    }

    Ok(Arc::new(InMemoryMessageBus::new()))
}

/// Delivery policy for a [`NatsMessageBus`]. Defaults mirror the Python adapter:
/// `max_deliver = 5`, `ack_wait = 30s`, `max_ack_pending = 256`.
#[cfg(feature = "nats")]
#[derive(Debug, Clone)]
pub struct NatsConfig {
    /// NATS server URL (e.g. `nats://localhost:4222`).
    pub url: String,
    /// JetStream stream name backing the subjects.
    pub stream: String,
    /// Subjects the stream captures.
    pub subjects: Vec<String>,
    /// Redelivery cap before a failing message is terminated (dead-lettered).
    pub max_deliver: i64,
    /// How long the server waits for an ack before redelivering. Must exceed the
    /// worst-case handler latency or an in-flight message is processed twice.
    pub ack_wait: Duration,
    /// Upper bound on unacked in-flight messages.
    pub max_ack_pending: i64,
}

#[cfg(feature = "nats")]
impl NatsConfig {
    /// Build a config with the default delivery policy for the given server, stream, and
    /// subjects.
    #[must_use]
    pub fn new(url: impl Into<String>, stream: impl Into<String>, subjects: Vec<String>) -> Self {
        Self {
            url: url.into(),
            stream: stream.into(),
            subjects,
            max_deliver: 5,
            ack_wait: Duration::from_secs(30),
            max_ack_pending: 256,
        }
    }

    /// Build a config from the environment, returning `None` when the `KEEL_NATS_URL` gate is
    /// unset or empty (so the default, broker-free deployment never constructs a NATS bus),
    /// mirroring [`KafkaConfig::from_env`](crate::kafka::KafkaConfig::from_env). `KEEL_NATS_STREAM`
    /// defaults to `keel` and `KEEL_NATS_SUBJECTS` (comma-separated) to `keel.>` (ADR-0025).
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let url = env_var("KEEL_NATS_URL")?;
        let stream = env_var("KEEL_NATS_STREAM").unwrap_or_else(|| "keel".to_string());
        let subjects = env_var("KEEL_NATS_SUBJECTS")
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|subjects| !subjects.is_empty())
            .unwrap_or_else(|| vec!["keel.>".to_string()]);
        Some(Self::new(url, stream, subjects))
    }
}

/// A [`MessageBus`] backed by NATS JetStream for durable at-least-once delivery.
///
/// Constructed already connected (see [`NatsMessageBus::connect`]): the stream is ensured
/// at construction, so there is no "connect before use" footgun and every `publish` /
/// `subscribe` runs against a live JetStream context.
#[cfg(feature = "nats")]
pub struct NatsMessageBus {
    client: Client,
    jetstream: JetStreamContext,
    stream: String,
    max_deliver: i64,
    ack_wait: Duration,
    max_ack_pending: i64,
}

#[cfg(feature = "nats")]
impl NatsMessageBus {
    /// Connect to the server and ensure the JetStream stream exists for the configured
    /// subjects, returning a ready-to-use bus.
    ///
    /// # Errors
    /// Returns [`MessagingError::Connect`] if the server is unreachable or the stream
    /// cannot be ensured.
    pub async fn connect(config: NatsConfig) -> Result<Self, MessagingError> {
        let client = async_nats::connect(&config.url)
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))?;
        let jetstream = async_nats::jetstream::new(client.clone());
        // get_or_create ensures the stream exists; a pre-existing stream is reused as-is.
        jetstream
            .get_or_create_stream(StreamConfig {
                name: config.stream.clone(),
                subjects: config.subjects.clone(),
                ..Default::default()
            })
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))?;
        Ok(Self {
            client,
            jetstream,
            stream: config.stream,
            max_deliver: config.max_deliver,
            ack_wait: config.ack_wait,
            max_ack_pending: config.max_ack_pending,
        })
    }

    /// Drain and close the connection (call at shutdown).
    ///
    /// # Errors
    /// Returns [`MessagingError::Connect`] if draining the connection fails.
    pub async fn close(self) -> Result<(), MessagingError> {
        self.client
            .drain()
            .await
            .map_err(|err| MessagingError::Connect(err.to_string()))
    }
}

#[cfg(feature = "nats")]
#[async_trait::async_trait]
impl MessagePublisher for NatsMessageBus {
    async fn publish(
        &self,
        subject: &str,
        payload: &[u8],
        headers: &HashMap<String, String>,
    ) -> Result<(), MessagingError> {
        let mut carrier = HeaderMap::new();
        for (key, value) in headers {
            carrier.insert(key.as_str(), value.as_str());
        }
        inject_trace_context(&mut carrier);
        let ack = self
            .jetstream
            .publish_with_headers(
                subject.to_string(),
                carrier,
                Bytes::copy_from_slice(payload),
            )
            .await
            .map_err(|err| MessagingError::Publish(err.to_string()))?;
        // The first await sends the publish; the returned future resolves when JetStream
        // acknowledges durable persistence. Awaiting it is what makes publish reliable.
        ack.await
            .map_err(|err| MessagingError::Publish(err.to_string()))?;
        Ok(())
    }
}

#[cfg(feature = "nats")]
#[async_trait::async_trait]
impl MessageBus for NatsMessageBus {
    async fn subscribe(
        &self,
        subject: &str,
        handler: MessageHandler,
    ) -> Result<(), MessagingError> {
        let stream = self
            .jetstream
            .get_stream(&self.stream)
            .await
            .map_err(|err| MessagingError::Subscribe(err.to_string()))?;
        let consumer = stream
            .create_consumer(PullConfig {
                durable_name: Some(durable_name(subject)),
                ack_policy: AckPolicy::Explicit,
                ack_wait: self.ack_wait,
                max_deliver: self.max_deliver,
                max_ack_pending: self.max_ack_pending,
                filter_subject: subject.to_string(),
                ..Default::default()
            })
            .await
            .map_err(|err| MessagingError::Subscribe(err.to_string()))?;
        let mut messages = consumer
            .messages()
            .await
            .map_err(|err| MessagingError::Subscribe(err.to_string()))?;

        let stream_name = self.stream.clone();
        let max_deliver = self.max_deliver;
        // The durable consumer keeps its cursor server-side, so this background loop can
        // own the message stream for the subscription's lifetime (like the Python
        // callback subscription). One bad message must never kill the loop.
        tokio::spawn(async move {
            while let Some(next) = messages.next().await {
                match next {
                    Ok(message) => {
                        dispatch(&message, &handler, &stream_name, max_deliver).await;
                    }
                    Err(err) => {
                        // A transport-level stream error (not a handler failure); log and
                        // keep polling so a transient hiccup does not end the subscription.
                        warn!(error = %err, stream = %stream_name, "jetstream message stream error");
                    }
                }
            }
        });
        Ok(())
    }
}

/// Inject the current trace context (W3C `traceparent`/`tracestate`) into `carrier`.
///
/// The context is taken from the active `tracing` span (the bridge the rest of the
/// vertical uses), so a publish inside an instrumented request carries that request's
/// trace across the broker. With no active span / no tracer installed this is a no-op.
#[cfg(feature = "nats")]
fn inject_trace_context(carrier: &mut HeaderMap) {
    let cx = tracing::Span::current().context();
    let mut injector = HeaderMapInjector(carrier);
    TraceContextPropagator::new().inject_context(&cx, &mut injector);
}

/// Inject the current trace context (W3C `traceparent`/`tracestate`) into a plain string header
/// map. The in-memory bus carries headers as a `HashMap` (there is no broker-native header type),
/// so it injects via this map carrier the same way the NATS adapter injects into its `HeaderMap`.
/// With no active span / no tracer installed this is a no-op.
fn inject_trace_context_into_map(carrier: &mut HashMap<String, String>) {
    let cx = tracing::Span::current().context();
    let mut injector = MapInjector(carrier);
    TraceContextPropagator::new().inject_context(&cx, &mut injector);
}

/// Extract a remote trace context from message `headers` (W3C `traceparent`/`tracestate`),
/// rooted at an empty context so the result is a clean remote parent. Shared across the
/// NATS and RabbitMQ adapters (both lift string headers off a delivery into a map).
pub(crate) fn extract_trace_context(headers: &HashMap<String, String>) -> OtelContext {
    let extractor = MapExtractor(headers);
    TraceContextPropagator::new().extract_with_context(&OtelContext::new(), &extractor)
}

/// Dispatch one delivered message to `handler` under its propagated trace context, then
/// ack / nak / term based on the outcome. Never returns an error: control-plane failures
/// are logged, not propagated, so the subscription loop keeps running.
#[cfg(feature = "nats")]
async fn dispatch(message: &Message, handler: &MessageHandler, stream: &str, max_deliver: i64) {
    let mut headers = HashMap::new();
    if let Some(header_map) = message.headers.as_ref() {
        for (name, values) in header_map.iter() {
            if let Some(value) = values.last() {
                headers.insert(name.to_string(), value.as_str().to_string());
            }
        }
    }
    let inbound = InboundMessage {
        subject: message.subject.to_string(),
        payload: message.payload.to_vec(),
        headers: headers.clone(),
    };

    // A consume span parented on the producer's remote trace, so handler log lines and
    // any nested spans link back to the publish side (the cross-broker trace link).
    let span = tracing::info_span!(
        "messaging.consume",
        messaging.system = "nats",
        messaging.destination = %message.subject,
    );
    // Errs only when no OpenTelemetry subscriber is installed (export off), the same
    // regime in which spans are no-ops here; ignore rather than log on every message.
    let _ = span.set_parent(extract_trace_context(&headers));

    let outcome = handler(inbound).instrument(span).await;
    let num_delivered = message.info().map(|info| info.delivered).unwrap_or(0);

    match disposition(outcome.is_ok(), num_delivered, max_deliver) {
        Disposition::Ack => control(message.ack(), "ack", &message.subject).await,
        Disposition::Redeliver => {
            if let Err(err) = &outcome {
                warn!(
                    subject = %message.subject,
                    num_delivered,
                    error = %err,
                    "message handler failed; scheduling redelivery",
                );
            }
            control(
                message.ack_with(AckKind::Nak(None)),
                "nak",
                &message.subject,
            )
            .await;
        }
        Disposition::DeadLetter => {
            if let Err(err) = &outcome {
                // Terminating drops the message from redelivery (dead-letter); this must
                // never be silent, so log the poison message's handler error at error.
                error!(
                    subject = %message.subject,
                    stream = %stream,
                    num_delivered,
                    max_deliver,
                    error = %err,
                    "message terminated after exhausting delivery attempts",
                );
            }
            control(message.ack_with(AckKind::Term), "term", &message.subject).await;
        }
    }
}

/// Await an ack/nak/term call, logging (not raising) a control-plane failure so a failed
/// acknowledgement surfaces instead of vanishing into silent redelivery anomalies.
#[cfg(feature = "nats")]
async fn control(
    op: impl Future<Output = Result<(), async_nats::Error>>,
    name: &str,
    subject: &str,
) {
    if let Err(err) = op.await {
        error!(op = name, subject = %subject, error = %err, "jetstream control call failed");
    }
}

/// The three ways a delivered message can be disposed of. Shared by the broker adapters; each
/// maps these onto its own ack/nak/dead-letter primitives. Gated to the broker features: it is a
/// redelivery/dead-letter concept, and the in-memory dev bus (the only always-compiled bus) has no
/// such disposition, so it would be dead code in the broker-free build.
#[cfg(any(feature = "nats", feature = "rabbitmq", feature = "kafka"))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Disposition {
    /// Handler succeeded: acknowledge.
    Ack,
    /// Handler failed under the delivery cap: nak for redelivery.
    Redeliver,
    /// Handler failed at/over the delivery cap: terminate (dead-letter).
    DeadLetter,
}

/// Decide a message's fate from the handler outcome and delivery count. Pure and
/// broker-agnostic, so the poison-handling policy is unit-testable without a broker and is
/// reused verbatim by the RabbitMQ adapter for its nak-vs-dead-letter decision.
#[cfg(any(feature = "nats", feature = "rabbitmq", feature = "kafka"))]
pub(crate) fn disposition(handler_ok: bool, num_delivered: i64, max_deliver: i64) -> Disposition {
    if handler_ok {
        Disposition::Ack
    } else if num_delivered >= max_deliver {
        Disposition::DeadLetter
    } else {
        Disposition::Redeliver
    }
}

/// Derive a stable, JetStream-safe durable consumer name from a subject (durable names
/// may not contain `.`/`*`/`>`), mirroring the Python adapter's `keel_<sanitized>`.
#[cfg(feature = "nats")]
fn durable_name(subject: &str) -> String {
    let safe: String = subject
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("keel_{safe}")
}

/// Injects W3C trace headers into an `async-nats` [`HeaderMap`].
#[cfg(feature = "nats")]
struct HeaderMapInjector<'a>(&'a mut HeaderMap);

#[cfg(feature = "nats")]
impl Injector for HeaderMapInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        self.0.insert(key, value);
    }
}

/// Injects W3C trace headers into a plain string header map (the carrier the in-memory bus uses,
/// since it has no broker-native header type).
struct MapInjector<'a>(&'a mut HashMap<String, String>);

impl Injector for MapInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        self.0.insert(key.to_string(), value);
    }
}

/// Extracts W3C trace headers from the string header map lifted off a delivered message.
struct MapExtractor<'a>(&'a HashMap<String, String>);

impl Extractor for MapExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(String::as_str).collect()
    }
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "nats")]
    use super::durable_name;
    #[cfg(any(feature = "nats", feature = "rabbitmq", feature = "kafka"))]
    use super::{disposition, Disposition};
    use super::{extract_trace_context, MapExtractor};
    use opentelemetry::propagation::Extractor;
    use std::collections::HashMap;

    #[cfg(feature = "nats")]
    #[test]
    fn durable_name_is_jetstream_safe_and_stable() {
        // Subject tokens (`.`) and wildcards must not leak into the durable name.
        assert_eq!(durable_name("orders.created"), "keel_orders_created");
        assert_eq!(durable_name("a.b.*"), "keel_a_b__");
        // Stable across calls for the same subject (the consumer must resume, not fork).
        assert_eq!(durable_name("events"), durable_name("events"));
    }

    #[cfg(any(feature = "nats", feature = "rabbitmq", feature = "kafka"))]
    #[test]
    fn disposition_acks_on_success_regardless_of_delivery_count() {
        assert_eq!(disposition(true, 1, 5), Disposition::Ack);
        assert_eq!(disposition(true, 99, 5), Disposition::Ack);
    }

    #[cfg(any(feature = "nats", feature = "rabbitmq", feature = "kafka"))]
    #[test]
    fn disposition_redelivers_under_the_cap_then_dead_letters_at_it() {
        // Under the cap: nak for another attempt.
        assert_eq!(disposition(false, 1, 5), Disposition::Redeliver);
        assert_eq!(disposition(false, 4, 5), Disposition::Redeliver);
        // At and beyond the cap: terminate (poison message, dead-lettered).
        assert_eq!(disposition(false, 5, 5), Disposition::DeadLetter);
        assert_eq!(disposition(false, 6, 5), Disposition::DeadLetter);
    }

    #[test]
    fn map_extractor_reads_keys_and_values() {
        let mut headers = HashMap::new();
        headers.insert("traceparent".to_string(), "abc".to_string());
        let extractor = MapExtractor(&headers);
        assert_eq!(extractor.get("traceparent"), Some("abc"));
        assert_eq!(extractor.get("missing"), None);
        assert_eq!(extractor.keys(), vec!["traceparent"]);
    }

    #[test]
    fn extract_trace_context_without_headers_is_invalid_parent() {
        // No traceparent -> no remote span context; extraction yields a context whose
        // span is invalid (the consume span would then start a fresh root trace).
        use opentelemetry::trace::TraceContextExt;
        let cx = extract_trace_context(&HashMap::new());
        assert!(!cx.span().span_context().is_valid());
    }

    #[test]
    fn extract_trace_context_parses_a_w3c_traceparent() {
        use opentelemetry::trace::TraceContextExt;
        let mut headers = HashMap::new();
        // A valid W3C traceparent: version-traceid-spanid-flags.
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
}
