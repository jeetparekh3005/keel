//! keel-core-rust: the shared platform library for the Rust vertical.
//!
//! Tier-1 per ADR-0009: ports (as traits), cross-cutting adapters, and a test kit,
//! all satisfying the language-agnostic contract in `platform.yaml`. This is the
//! foundation scaffold; subsequent slices (epic #36) add config, the error model,
//! logging, telemetry, the HTTP edge, auth, persistence, and the conformance kit.

pub mod adapters;
pub mod api_key;
pub mod auth;
/// AWS Secrets Manager `SecretProvider` adapter (ADR-0024), a loader over the shared
/// [`secret`] caching core. Opt-in: enable the `aws` feature so the default build pulls in
/// neither the AWS SDK nor an async IO driver, mirroring the `vault` feature gating OpenBao.
#[cfg(feature = "aws")]
pub mod aws;
pub mod config;
pub mod domain;
/// GCP Secret Manager `SecretProvider` adapter (ADR-0024), a loader over the shared [`secret`]
/// caching core. Opt-in: enable the `gcp` feature so the default build pulls in neither the GCP SDK
/// nor an async IO driver, mirroring the `aws`/`vault` features. The Rust vertical uses `gcloud-sdk`
/// (not the official google-cloud-rust crate) for a ring-only TLS tree; see the module docs and
/// ADR-0024.
#[cfg(feature = "gcp")]
pub mod gcp;
/// Generated gRPC stubs for the `keel.reference.v1` contract (ADR-0022). Opt-in:
/// enable the `grpc` feature (mirrors the Python `keel-core[grpc]` extra) so the
/// default build needs neither prost nor tonic.
#[cfg(feature = "grpc")]
pub mod genproto;
/// gRPC server factory (deny-by-default auth + per-method scope authz + OTel) and mTLS
/// credential builders for the `keel.reference.v1` contract (ADR-0022). Opt-in behind the
/// `grpc` feature, alongside the generated stubs in [`genproto`].
#[cfg(feature = "grpc")]
pub mod grpc;
pub mod http;
pub mod jwks;
pub mod logging;
/// NATS JetStream `MessageBus` adapter. Opt-in: enable the `nats` feature (mirrors the
/// Python `keel-core[nats]` extra) so the default build needs no broker.
#[cfg(feature = "nats")]
pub mod messaging;
pub mod persistence;
pub mod ports;
pub mod redact;
/// Shared caching core for the production `SecretProvider` backends (ADR-0024): the cache,
/// background refresh, fail-closed construction, no-leak serving, and the fail-closed
/// `secret_provider_from_env` selector, parameterized by a per-backend loader. Compiled only
/// when a production backend feature (`vault`, `aws`, or `gcp`) is enabled.
#[cfg(any(feature = "vault", feature = "aws", feature = "gcp"))]
pub mod secret;
pub mod telemetry;
pub mod testkit;
/// OpenBao (and HashiCorp Vault) `SecretProvider` adapter over the KV v2 HTTP API
/// (ADR-0023). Opt-in: enable the `vault` feature (which turns on `reqwest/blocking`) so
/// the default build stays env-only, mirroring the `nats` feature gating the broker.
#[cfg(feature = "vault")]
pub mod vault;
pub mod webauth;

/// The platform `contractVersion` this vertical targets (`platform.yaml`
/// `metadata.contractVersion`). A generated project records the version it targets.
pub const CONTRACT_VERSION: &str = "0.2.0";

/// Serializes the tests that install the process-global OpenTelemetry MeterProvider, so a
/// concurrent install cannot clobber the global between a test's `set_meter_provider` and
/// the point it reads its instruments back. The guard protects ordering, not shared data,
/// so a poisoned lock is recovered rather than propagated.
#[cfg(test)]
pub(crate) static OTEL_GLOBAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_matches_the_platform_contract() {
        assert_eq!(CONTRACT_VERSION, "0.2.0");
    }
}
