//! NatsMessageBus against a real NATS JetStream server (epic #419, v0.6 parity).
//!
//! Mirrors the Python vertical's NATS integration test: a publish -> subscribe round-trip
//! over a live broker that asserts BOTH halves of the contract -- the payload (and app
//! headers) are delivered durably, AND the producer's trace context propagates through the
//! message headers so the consumer span links to the published trace (same trace id on
//! both sides). A second test drives the poison path: a handler that always fails is
//! redelivered up to the cap, then terminated (dead-lettered), never looping forever.
//!
//! Gated like the Rust Postgres and Keycloak integration tests: the whole file compiles
//! only under the `nats` feature, and each test is `#[ignore]`d so a plain `cargo test`
//! reports it as "ignored" rather than silently passing. CI runs them with
//! `--include-ignored` after starting a NATS container and setting `KEEL_NATS_URL`.
//! Running them without `KEEL_NATS_URL` fails loudly (the `expect` below), never a false
//! pass.

#![cfg(feature = "nats")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use keel_core::messaging::{
    HandlerFuture, InboundMessage, MessageBus, MessageHandler, MessagePublisher, NatsConfig,
    NatsMessageBus,
};
use opentelemetry::trace::TraceContextExt;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing::subscriber::DefaultGuard;
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::prelude::*;

/// Install a real tracer as the thread-local default subscriber so spans carry genuine
/// (non-zero) trace ids; without one the propagation assertion would compare two all-zero
/// ids and prove nothing. The returned guard must be held for the test's duration.
///
/// The current-thread runtime (dev tokio has no rt-multi-thread) runs the spawned consumer
/// task on this very thread, so it sees this thread-local default.
fn install_tracer() -> DefaultGuard {
    let provider = SdkTracerProvider::builder().build();
    let tracer = opentelemetry::trace::TracerProvider::tracer(&provider, "nats-integration-test");
    let subscriber =
        tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(tracer));
    tracing::subscriber::set_default(subscriber)
}

fn require_url() -> String {
    std::env::var("KEEL_NATS_URL").expect("KEEL_NATS_URL must be set to run this integration test")
}

#[tokio::test]
#[ignore = "integration: requires KEEL_NATS_URL (NATS JetStream); run with `cargo test --features nats -- --include-ignored`"]
async fn publish_subscribe_roundtrip_delivers_payload_headers_and_propagates_trace() {
    let url = require_url();
    let _guard = install_tracer();

    // Unique stream/subject per run so repeated runs never share a durable cursor.
    let uid = uuid::Uuid::new_v4().simple().to_string();
    let subject = format!("keeltest.{uid}");
    let stream = format!("KEELTEST_{uid}");

    let bus = NatsMessageBus::connect(NatsConfig::new(&url, &stream, vec![subject.clone()]))
        .await
        .expect("connect to NATS JetStream and ensure the stream");

    // The consumer hands back (payload, trace_id, app-header value) so one assertion proves
    // the body, the propagated trace, and that app headers survive the round-trip.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(Vec<u8>, String, Option<String>)>(8);
    let handler: MessageHandler = Arc::new(move |message: InboundMessage| {
        let tx = tx.clone();
        Box::pin(async move {
            // Read the trace id of the span the adapter ran us inside: it must match the
            // publisher's trace id if context propagated across the broker.
            let cx = tracing::Span::current().context();
            let trace_id = cx.span().span_context().trace_id().to_string();
            let app_header = message.headers.get("x-keel-app").cloned();
            let _ = tx.send((message.payload, trace_id, app_header)).await;
            Ok(())
        }) as HandlerFuture
    });

    bus.subscribe(&subject, handler)
        .await
        .expect("subscribe a durable consumer");

    // Publish inside a span; capture its trace id to compare against the consumed side.
    let publish_span = tracing::info_span!("test.publish");
    let expected_trace_id = {
        let cx = publish_span.context();
        cx.span().span_context().trace_id().to_string()
    };
    assert_ne!(
        expected_trace_id, "00000000000000000000000000000000",
        "the publish span must carry a real trace id (tracer not wired up?)",
    );

    let payload = b"keel-nats-roundtrip".to_vec();
    let mut headers = HashMap::new();
    headers.insert("x-keel-app".to_string(), "ping".to_string());
    async {
        bus.publish(&subject, &payload, &headers)
            .await
            .expect("publish to JetStream");
    }
    .instrument(publish_span)
    .await;

    let (received_payload, received_trace_id, received_app_header) =
        tokio::time::timeout(Duration::from_secs(15), rx.recv())
            .await
            .expect("a message should be delivered within the timeout")
            .expect("the channel should yield the delivered message");

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
        "the consumed span must link to the published trace (W3C context over headers)",
    );

    bus.close().await.expect("drain the connection");
}

#[tokio::test]
#[ignore = "integration: requires KEEL_NATS_URL (NATS JetStream); run with `cargo test --features nats -- --include-ignored`"]
async fn poison_message_is_redelivered_up_to_the_cap_then_terminated() {
    let url = require_url();
    let _guard = install_tracer();

    let uid = uuid::Uuid::new_v4().simple().to_string();
    let subject = format!("keelpoison.{uid}");
    let stream = format!("KEELPOISON_{uid}");

    // Small cap + short ack_wait so the redeliver->terminate cycle completes in seconds.
    let mut config = NatsConfig::new(&url, &stream, vec![subject.clone()]);
    config.max_deliver = 3;
    config.ack_wait = Duration::from_secs(1);

    let bus = NatsMessageBus::connect(config)
        .await
        .expect("connect to NATS JetStream and ensure the stream");

    // A handler that always fails: each delivery is nak'd until the cap, then the message
    // is term'd. The counter proves it was delivered exactly `max_deliver` times -- not
    // fewer (gave up early) and not forever (poison loop).
    let deliveries = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&deliveries);
    let handler: MessageHandler = Arc::new(move |_message: InboundMessage| {
        let seen = Arc::clone(&seen);
        Box::pin(async move {
            seen.fetch_add(1, Ordering::SeqCst);
            Err("handler always fails".into())
        }) as HandlerFuture
    });

    bus.subscribe(&subject, handler)
        .await
        .expect("subscribe a durable consumer");

    bus.publish(&subject, b"poison", &HashMap::new())
        .await
        .expect("publish the poison message");

    // Wait until the handler has been hit the full cap of times.
    let deadline = Duration::from_secs(20);
    let start = std::time::Instant::now();
    while deliveries.load(Ordering::SeqCst) < 3 {
        assert!(
            start.elapsed() < deadline,
            "poison message was not redelivered up to the cap in time (got {} deliveries)",
            deliveries.load(Ordering::SeqCst),
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // After termination there must be no further redelivery: the count stays pinned at the
    // cap even once another ack_wait window has elapsed.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        deliveries.load(Ordering::SeqCst),
        3,
        "a terminated message must not be redelivered beyond the cap",
    );

    bus.close().await.expect("drain the connection");
}
