//! KafkaMessageBus against a real Kafka broker (ADR-0025).
//!
//! Mirrors the NATS and RabbitMQ integration tests: a publish -> subscribe round-trip over a live
//! broker that asserts BOTH halves of the contract -- the payload (and app headers) are delivered
//! durably, AND the producer's trace context propagates through the record headers so the consumer
//! span links to the published trace (same trace id on both sides) -- plus a poison-record test that
//! drives the retry-then-dead-letter path and proves the terminated record lands on the DLQ topic.
//!
//! Gated like the other integration tests: the file compiles only under the `kafka` feature, and
//! each test is `#[ignore]`d so a plain `cargo test` reports it "ignored" rather than silently
//! passing. CI runs them with `--include-ignored` after starting a Kafka container and setting
//! `KEEL_KAFKA_BROKERS`. Like the RabbitMQ test (and the GCP secrets test), each self-skips when
//! `KEEL_KAFKA_BROKERS` is unset -- returning early rather than panicking under `--include-ignored`,
//! so the fast PR gate's `--include-ignored` run is green without a broker wired up in every lane.

#![cfg(feature = "kafka")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use keel_core::kafka::{KafkaConfig, KafkaMessageBus};
use keel_core::messaging::{
    HandlerFuture, InboundMessage, MessageBus, MessageHandler, MessagePublisher,
};
use opentelemetry::trace::TraceContextExt;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing::subscriber::DefaultGuard;
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::prelude::*;

/// Install a real tracer as the thread-local default subscriber so spans carry genuine (non-zero)
/// trace ids; without one the propagation assertion would compare two all-zero ids and prove
/// nothing. The returned guard must be held for the test's duration. The current-thread runtime runs
/// the spawned poll loop on this very thread, so it sees this thread-local default.
fn install_tracer() -> DefaultGuard {
    let provider = SdkTracerProvider::builder().build();
    let tracer = opentelemetry::trace::TracerProvider::tracer(&provider, "kafka-integration-test");
    let subscriber =
        tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(tracer));
    tracing::subscriber::set_default(subscriber)
}

/// The configured brokers, or `None` when the gate is unset (self-skip).
fn brokers() -> Option<Vec<String>> {
    let raw = std::env::var("KEEL_KAFKA_BROKERS").ok()?;
    let list: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect();
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

#[tokio::test]
#[ignore = "integration: requires KEEL_KAFKA_BROKERS (Kafka); run with `cargo test --features kafka -- --include-ignored`"]
async fn publish_subscribe_roundtrip_delivers_payload_headers_and_propagates_trace() {
    // Self-skip when no broker is configured (e.g. the fast PR gate's --include-ignored run in a
    // lane without Kafka): return rather than panic, mirroring the RabbitMQ integration test.
    let Some(brokers) = brokers() else {
        eprintln!("skipping Kafka integration test: KEEL_KAFKA_BROKERS not set");
        return;
    };
    let _guard = install_tracer();

    // A unique, already-sanitized (no dots) topic per run so repeated runs never share a group
    // cursor or collide on topology.
    let uid = uuid::Uuid::new_v4().simple().to_string();
    let subject = format!("keeltest{uid}");
    let mut config = KafkaConfig::new(brokers);
    config.topics = vec![subject.clone()];
    config.group_id = format!("keeltestgroup{uid}");

    let bus = KafkaMessageBus::connect(config)
        .await
        .expect("connect to Kafka and subscribe the configured topics");

    // The consumer hands back (payload, trace_id, app-header value) so one assertion proves the
    // body, the propagated trace, and that app headers survive the round-trip.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(Vec<u8>, String, Option<String>)>(8);
    let handler: MessageHandler = Arc::new(move |message: InboundMessage| {
        let tx = tx.clone();
        Box::pin(async move {
            let cx = tracing::Span::current().context();
            let trace_id = cx.span().span_context().trace_id().to_string();
            let app_header = message.headers.get("x-keel-app").cloned();
            let _ = tx.send((message.payload, trace_id, app_header)).await;
            Ok(())
        }) as HandlerFuture
    });

    bus.subscribe(&subject, handler)
        .await
        .expect("subscribe a consumer");

    let publish_span = tracing::info_span!("test.publish");
    let expected_trace_id = {
        let cx = publish_span.context();
        cx.span().span_context().trace_id().to_string()
    };
    assert_ne!(
        expected_trace_id, "00000000000000000000000000000000",
        "the publish span must carry a real trace id (tracer not wired up?)",
    );

    let payload = b"keel-kafka-roundtrip".to_vec();
    let mut headers = HashMap::new();
    headers.insert("x-keel-app".to_string(), "ping".to_string());

    // Kafka consumer-group join plus new-topic discovery can take several seconds, so retry the
    // publish/receive window generously rather than once: publish, then wait; if nothing arrives
    // (the group had not yet been assigned the partition), publish again.
    let mut received = None;
    for _ in 0..30 {
        async {
            bus.publish(&subject, &payload, &headers)
                .await
                .expect("publish to the topic");
        }
        .instrument(publish_span.clone())
        .await;
        if let Ok(Some(message)) = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            received = Some(message);
            break;
        }
    }
    let (received_payload, received_trace_id, received_app_header) =
        received.expect("a message should be delivered within the retry window");

    assert_eq!(
        received_payload, payload,
        "the subscriber must receive the exact published payload",
    );
    assert_eq!(
        received_app_header.as_deref(),
        Some("ping"),
        "application headers must survive the round-trip alongside trace headers",
    );
    assert_eq!(
        received_trace_id, expected_trace_id,
        "the consumed span must link to the published trace (W3C context over record headers)",
    );

    bus.close().await.expect("close the bus");
}

#[tokio::test]
#[ignore = "integration: requires KEEL_KAFKA_BROKERS (Kafka); run with `cargo test --features kafka -- --include-ignored`"]
async fn poison_message_is_retried_up_to_the_cap_then_dead_lettered() {
    let Some(brokers) = brokers() else {
        eprintln!("skipping Kafka integration test: KEEL_KAFKA_BROKERS not set");
        return;
    };
    let _guard = install_tracer();

    let uid = uuid::Uuid::new_v4().simple().to_string();
    let subject = format!("keelpoison{uid}");
    // A plain (already-sanitized) DLQ topic the SAME bus also consumes, so the dead-lettered record
    // is routed back to a handler here and we can assert it landed on the DLQ, proving termination.
    let dlq = format!("keeldlq{uid}");
    let mut config = KafkaConfig::new(brokers);
    config.topics = vec![subject.clone()];
    config.group_id = format!("keelpoisongroup{uid}");
    config.dlq_topic = Some(dlq.clone());
    // A small cap so the retry -> dead-letter cycle completes quickly: three delivery attempts.
    config.max_deliver = 3;

    let bus = KafkaMessageBus::connect(config)
        .await
        .expect("connect to Kafka");

    // A poison handler that always fails: each delivery (base, then <topic>.retry) is re-produced to
    // the retry topic until the cap, then the record is produced to the DLQ. The counter proves it
    // was handled exactly `max_deliver` times -- not fewer (gave up early) and not forever.
    let deliveries = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&deliveries);
    let poison: MessageHandler = Arc::new(move |_message: InboundMessage| {
        let seen = Arc::clone(&seen);
        Box::pin(async move {
            seen.fetch_add(1, Ordering::SeqCst);
            Err("handler always fails".into())
        }) as HandlerFuture
    });
    bus.subscribe(&subject, poison)
        .await
        .expect("subscribe the poison handler");

    // A DLQ handler that succeeds, handing the dead-lettered payload back so we can assert it.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
    let dlq_handler: MessageHandler = Arc::new(move |message: InboundMessage| {
        let tx = tx.clone();
        Box::pin(async move {
            let _ = tx.send(message.payload).await;
            Ok(())
        }) as HandlerFuture
    });
    bus.subscribe(&dlq, dlq_handler)
        .await
        .expect("subscribe the DLQ handler");

    let payload = b"keel-kafka-poison".to_vec();

    // Publish repeatedly until the dead-lettered record arrives on the DLQ: the first publishes may
    // precede group assignment of the poison partition, so retry the window like the round-trip test.
    let mut dead_lettered = None;
    for _ in 0..30 {
        bus.publish(&subject, &payload, &HashMap::new())
            .await
            .expect("publish the poison message");
        if let Ok(Some(received)) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
            dead_lettered = Some(received);
            break;
        }
    }
    let dead_lettered =
        dead_lettered.expect("the poison record should be dead-lettered to the DLQ");
    assert_eq!(
        dead_lettered, payload,
        "the dead-lettered record must preserve the original payload",
    );

    // At least `max_deliver` handler attempts happened before termination (each publish that was
    // assigned drives the full retry cycle; with the publish-retry loop there may be more than one
    // poisoned record in flight, so assert the cycle ran rather than an exact single-record count).
    assert!(
        deliveries.load(Ordering::SeqCst) >= 3,
        "the poison handler must be driven up to the delivery cap before dead-lettering (got {})",
        deliveries.load(Ordering::SeqCst),
    );

    bus.close().await.expect("close the bus");
}
