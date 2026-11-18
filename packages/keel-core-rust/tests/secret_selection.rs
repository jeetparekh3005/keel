//! Fail-closed backend selection for `secret_provider_from_env` (ADR-0024 protocol "Selection").
//!
//! An integration test (its own process) so mutating the gating env vars cannot race the unit
//! tests that also read the environment. Compiles only when a production backend feature is on;
//! no assertion constructs a backend over the network (MultipleBackends short-circuits, the
//! none-set case returns the env provider, and each single-backend branch fails in config parsing
//! before any client build), so no network or cloud credentials are needed.

#![cfg(any(feature = "vault", feature = "aws", feature = "gcp"))]

#[cfg(feature = "aws")]
use keel_core::aws::AwsError;
#[cfg(feature = "gcp")]
use keel_core::gcp::GcpError;
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
        "KEEL_GCP_SECRET",
        "KEEL_GCP_SECRET_VERSION",
        "KEEL_SECRET_CACHE_TTL_SECONDS",
        "KEEL_SECRET_SELECT_PROBE",
    ]);

    // Clean slate so a stray ambient var cannot perturb the counts below.
    std::env::remove_var("KEEL_VAULT_ADDR");
    std::env::remove_var("KEEL_AWS_SECRET_ID");
    std::env::remove_var("KEEL_GCP_SECRET");
    std::env::remove_var("KEEL_GCP_SECRET_VERSION");
    std::env::remove_var("KEEL_SECRET_CACHE_TTL_SECONDS");

    // Two backends set at once is an ambiguous misconfiguration that fails before constructing
    // either backend, not a silent pick.
    std::env::set_var("KEEL_VAULT_ADDR", "https://openbao:8200");
    std::env::set_var("KEEL_AWS_SECRET_ID", "keel-test");
    let result = secret_provider_from_env();
    assert!(
        matches!(result, Err(SecretProviderError::MultipleBackends)),
        "two gating vars must fail closed as MultipleBackends",
    );

    // GCP paired with another backend is equally ambiguous.
    std::env::remove_var("KEEL_AWS_SECRET_ID");
    std::env::set_var("KEEL_GCP_SECRET", "projects/p/secrets/app");
    let result = secret_provider_from_env();
    assert!(
        matches!(result, Err(SecretProviderError::MultipleBackends)),
        "vault + gcp must fail closed as MultipleBackends",
    );

    // No gating var set yields the dev env provider, which reads straight from the process env.
    std::env::remove_var("KEEL_VAULT_ADDR");
    std::env::remove_var("KEEL_AWS_SECRET_ID");
    std::env::remove_var("KEEL_GCP_SECRET");
    std::env::set_var("KEEL_SECRET_SELECT_PROBE", "from-the-environment");
    let provider = secret_provider_from_env().expect("no gating var selects the env provider");
    assert_eq!(
        provider.get("KEEL_SECRET_SELECT_PROBE").as_deref(),
        Some("from-the-environment"),
        "with no backend configured, get() must fall through to the environment",
    );
    std::env::remove_var("KEEL_SECRET_SELECT_PROBE");

    // Only KEEL_AWS_SECRET_ID set selects the AWS backend. Proven hermetically - no IMDS, no
    // network: a deliberately invalid shared cache TTL makes AwsSecretsConfig::from_env fail in
    // config parsing, before any SDK client build or credential/IMDS call, and the failure
    // surfaces as the AWS variant. So the AWS branch was taken (not Vault, not the env provider).
    #[cfg(feature = "aws")]
    {
        std::env::remove_var("KEEL_VAULT_ADDR");
        std::env::remove_var("KEEL_GCP_SECRET");
        std::env::set_var("KEEL_AWS_SECRET_ID", "keel-test");
        std::env::set_var("KEEL_SECRET_CACHE_TTL_SECONDS", "not-a-number");
        let result = secret_provider_from_env();
        assert!(
            matches!(result, Err(SecretProviderError::Aws(AwsError::Config(_)))),
            "only KEEL_AWS_SECRET_ID set must select the AWS backend (fail-fast in config parsing, no network)",
        );
        std::env::remove_var("KEEL_AWS_SECRET_ID");
    }

    // Only KEEL_GCP_SECRET set selects the GCP backend. Proven hermetically the same way: a bad
    // shared cache TTL makes GcpSecretsConfig::from_env fail in config parsing, before any SDK
    // client build, ADC resolution, or metadata-server probe. So the GCP branch was taken.
    #[cfg(feature = "gcp")]
    {
        std::env::remove_var("KEEL_VAULT_ADDR");
        std::env::remove_var("KEEL_AWS_SECRET_ID");
        std::env::set_var("KEEL_GCP_SECRET", "projects/p/secrets/app");
        std::env::set_var("KEEL_SECRET_CACHE_TTL_SECONDS", "not-a-number");
        let result = secret_provider_from_env();
        assert!(
            matches!(result, Err(SecretProviderError::Gcp(GcpError::Config(_)))),
            "only KEEL_GCP_SECRET set must select the GCP backend (fail-fast in config parsing, no network)",
        );
        std::env::remove_var("KEEL_GCP_SECRET");
        std::env::remove_var("KEEL_SECRET_CACHE_TTL_SECONDS");
    }

    saved.restore();
}
