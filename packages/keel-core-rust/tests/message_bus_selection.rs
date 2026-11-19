//! Fail-closed broker selection for `message_bus_from_env` (ADR-0025 decision 3).
//!
//! An integration test (its own process) so mutating the gating env vars cannot race the unit
//! tests that also read the environment, exactly like `secret_selection.rs`. Unlike that file it is
//! NOT gated on a broker feature: the selector and the in-memory dev bus are in the default build,
//! so this runs under `cargo test` with no features AND under `--features nats,kafka,rabbitmq`.
//!
//! Broker-free in every build: `MultipleBackends` short-circuits before any connect, the none-set
//! case returns the in-memory dev bus (exercised with a real publish/subscribe round-trip), and
//! each `BackendNotCompiled` assertion is gated to the build where that broker feature is OFF, so
//! no branch here ever attempts a network connect.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use keel_core::messaging::{
    message_bus_from_env, HandlerFuture, InboundMessage, MessageBusError, MessageHandler,
};

/// Save and restore a set of env vars around a test that mutates them.
struct EnvSnapshot {
    saved: Vec<(String, Option<String>)>,
}

impl EnvSnapshot {
    fn take(keys: &[&str]) -> Self {
        Self {
            saved: keys
                .iter()
                .map(|key| ((*key).to_string(), std::env::var(key).ok()))
                .collect(),
        }
    }

    fn clear(&self) {
        for (key, _) in &self.saved {
            std::env::remove_var(key);
        }
    }

    fn restore(&self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[tokio::test]
async fn selection_is_fail_closed_across_the_gating_vars() {
    let saved = EnvSnapshot::take(&["KEEL_NATS_URL", "KEEL_KAFKA_BROKERS", "KEEL_RABBITMQ_URL"]);
    // Clean slate so a stray ambient var cannot perturb the counts below.
    saved.clear();

    // More than one gate set is an ambiguous misconfiguration that fails before constructing any
    // bus. This short-circuits before any network connect, so it is safe under all broker features.
    std::env::set_var("KEEL_NATS_URL", "nats://localhost:4222");
    std::env::set_var("KEEL_KAFKA_BROKERS", "localhost:9092");
    let result = message_bus_from_env().await;
    assert!(
        matches!(result, Err(MessageBusError::MultipleBackends)),
        "two gating vars must fail closed as MultipleBackends",
    );

    // A different pairing is equally ambiguous.
    std::env::remove_var("KEEL_KAFKA_BROKERS");
    std::env::set_var("KEEL_RABBITMQ_URL", "amqp://localhost:5672");
    let result = message_bus_from_env().await;
    assert!(
        matches!(result, Err(MessageBusError::MultipleBackends)),
        "nats + rabbitmq must fail closed as MultipleBackends",
    );

    // No gate set yields the in-memory dev bus. Prove it is a working bus with a round-trip:
    // subscribe, publish, and confirm the handler ran synchronously in-process (the dev default
    // dispatches inline, so the flag is set by the time `publish` returns).
    saved.clear();
    let bus = message_bus_from_env()
        .await
        .expect("no gating var selects the in-memory dev bus");
    let delivered = Arc::new(AtomicBool::new(false));
    let seen = Arc::clone(&delivered);
    let handler: MessageHandler = Arc::new(move |message: InboundMessage| {
        let seen = Arc::clone(&seen);
        Box::pin(async move {
            assert_eq!(
                message.payload, b"keel-inmemory",
                "the subscriber must receive the exact published payload",
            );
            seen.store(true, Ordering::SeqCst);
            Ok(())
        }) as HandlerFuture
    });
    bus.subscribe("keel.select.probe", handler)
        .await
        .expect("subscribe on the in-memory bus");
    bus.publish("keel.select.probe", b"keel-inmemory", &HashMap::new())
        .await
        .expect("publish on the in-memory bus");
    assert!(
        delivered.load(Ordering::SeqCst),
        "the in-memory dev bus must dispatch the published message to the subscriber",
    );

    // A gating var set whose broker feature is NOT compiled fails closed as BackendNotCompiled,
    // never silently falling through to the in-memory bus. Each assertion is gated to the build
    // where that feature is off, so no branch below attempts a real connect.
    #[cfg(not(feature = "nats"))]
    {
        saved.clear();
        std::env::set_var("KEEL_NATS_URL", "nats://localhost:4222");
        let result = message_bus_from_env().await;
        assert!(
            matches!(
                result,
                Err(MessageBusError::BackendNotCompiled("KEEL_NATS_URL"))
            ),
            "KEEL_NATS_URL without the nats feature must fail closed as BackendNotCompiled",
        );
    }
    #[cfg(not(feature = "kafka"))]
    {
        saved.clear();
        std::env::set_var("KEEL_KAFKA_BROKERS", "localhost:9092");
        let result = message_bus_from_env().await;
        assert!(
            matches!(
                result,
                Err(MessageBusError::BackendNotCompiled("KEEL_KAFKA_BROKERS"))
            ),
            "KEEL_KAFKA_BROKERS without the kafka feature must fail closed as BackendNotCompiled",
        );
    }
    #[cfg(not(feature = "rabbitmq"))]
    {
        saved.clear();
        std::env::set_var("KEEL_RABBITMQ_URL", "amqp://localhost:5672");
        let result = message_bus_from_env().await;
        assert!(
            matches!(
                result,
                Err(MessageBusError::BackendNotCompiled("KEEL_RABBITMQ_URL"))
            ),
            "KEEL_RABBITMQ_URL without the rabbitmq feature must fail closed as BackendNotCompiled",
        );
    }

    saved.restore();
}
