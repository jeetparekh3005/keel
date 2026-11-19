//! RabbitMqMessageBus against a real RabbitMQ broker (ADR-0025).
//!
//! Mirrors the NATS integration test: a publish -> subscribe round-trip over a live broker that
//! asserts BOTH halves of the contract -- the payload (and app headers) are delivered durably, AND
//! the producer's trace context propagates through the AMQP headers so the consumer span links to
//! the published trace (same trace id on both sides).
//!
//! Gated like the other integration tests: the file compiles only under the `rabbitmq` feature,
//! and the test is `#[ignore]`d so a plain `cargo test` reports it "ignored" rather than silently
//! passing. CI runs it with `--include-ignored` after starting a RabbitMQ container and setting
//! `KEEL_RABBITMQ_URL`. Unlike the NATS test (which `expect`s the URL), this self-skips when
//! `KEEL_RABBITMQ_URL` is unset -- returning early rather than panicking under `--include-ignored`,
//! the same no-op-when-absent shape as the GCP secrets integration test -- so the fast PR gate's
//! `--include-ignored` run is green without a broker wired up in every lane.

#![cfg(feature = "rabbitmq")]

use std::collections::HashMap;
use std::time::Duration;

use keel_core::messaging::{
    HandlerFuture, InboundMessage, MessageBus, MessageHandler, MessagePublisher,
};
use keel_core::rabbitmq::{RabbitMqConfig, RabbitMqMessageBus};
use opentelemetry::trace::TraceContextExt;
use opentelemetry_sdk::trace::SdkTracerProvider;
use std::sync::Arc;
use tracing::subscriber::DefaultGuard;
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::prelude::*;

/// Install a real tracer as the thread-local default subscriber so spans carry genuine (non-zero)
/// trace ids; without one the propagation assertion would compare two all-zero ids and prove
/// nothing. The returned guard must be held for the test's duration.
fn install_tracer() -> DefaultGuard {
    let provider = SdkTracerProvider::builder().build();
    let tracer =
        opentelemetry::trace::TracerProvider::tracer(&provider, "rabbitmq-integration-test");
    let subscriber =
        tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(tracer));
    tracing::subscriber::set_default(subscriber)
}

#[tokio::test]
#[ignore = "integration: requires KEEL_RABBITMQ_URL (RabbitMQ); run with `cargo test --features rabbitmq -- --include-ignored`"]
async fn publish_subscribe_roundtrip_delivers_payload_headers_and_propagates_trace() {
    // Self-skip when no broker is configured (e.g. the fast PR gate's --include-ignored run):
    // return rather than panic, mirroring the GCP secrets integration test. A real run with the
    // env set still exercises the full round-trip below.
    let Ok(url) = std::env::var("KEEL_RABBITMQ_URL") else {
        eprintln!("skipping RabbitMQ integration test: KEEL_RABBITMQ_URL not set");
        return;
    };
    let _guard = install_tracer();

    // Unique exchange/queue/subject per run so repeated runs never collide on topology or share a
    // queue cursor.
    let uid = uuid::Uuid::new_v4().simple().to_string();
    let subject = format!("keeltest.{uid}");
    let mut config = RabbitMqConfig::new(&url);
    config.exchange = format!("keeltest.ex.{uid}");
    config.queue = format!("keeltest.q.{uid}");
    config.dlx = format!("keeltest.dlx.{uid}");
    config.subjects = vec![subject.clone()];

    let bus = RabbitMqMessageBus::connect(config)
        .await
        .expect("connect to RabbitMQ and declare the topology");

    // The consumer hands back (payload, trace_id, app-header value) so one assertion proves the
    // body, the propagated trace, and that app headers survive the round-trip.
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
        .expect("subscribe a consumer");

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

    let payload = b"keel-rabbitmq-roundtrip".to_vec();
    let mut headers = HashMap::new();
    headers.insert("x-keel-app".to_string(), "ping".to_string());
    async {
        bus.publish(&subject, &payload, &headers)
            .await
            .expect("publish to the exchange");
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
        "the consumed span must link to the published trace (W3C context over AMQP headers)",
    );

    bus.close().await.expect("close the connection");
}
