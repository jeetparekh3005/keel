//! Fail-closed backend selection for `secret_provider_from_env` (ADR-0024 protocol "Selection").
//!
//! An integration test (its own process) so mutating the gating env vars cannot race the unit
//! tests that also read the environment. Compiles only when a production backend feature is on;
//! neither assertion constructs a backend (MultipleBackends short-circuits, and the none-set case
//! returns the env provider), so no network or cloud credentials are needed.

#![cfg(any(feature = "vault", feature = "aws"))]

use keel_core::secret::{secret_provider_from_env, SecretProviderError};

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

    fn restore(&self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[test]
fn selection_is_fail_closed_across_the_gating_vars() {
    let saved = EnvSnapshot::take(&[
        "KEEL_VAULT_ADDR",
        "KEEL_AWS_SECRET_ID",
        "KEEL_SECRET_SELECT_PROBE",
    ]);

    // Two backends set at once is an ambiguous misconfiguration that fails before constructing
    // either backend, not a silent pick.
    std::env::set_var("KEEL_VAULT_ADDR", "https://openbao:8200");
    std::env::set_var("KEEL_AWS_SECRET_ID", "keel-test");
    let result = secret_provider_from_env();
    assert!(
        matches!(result, Err(SecretProviderError::MultipleBackends)),
        "two gating vars must fail closed as MultipleBackends",
    );

    // No gating var set yields the dev env provider, which reads straight from the process env.
    std::env::remove_var("KEEL_VAULT_ADDR");
    std::env::remove_var("KEEL_AWS_SECRET_ID");
    std::env::set_var("KEEL_SECRET_SELECT_PROBE", "from-the-environment");
    let provider = secret_provider_from_env().expect("no gating var selects the env provider");
    assert_eq!(
        provider.get("KEEL_SECRET_SELECT_PROBE").as_deref(),
        Some("from-the-environment"),
        "with no backend configured, get() must fall through to the environment",
    );

    saved.restore();
}
