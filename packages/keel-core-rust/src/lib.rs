//! keel-core-rust: the shared platform library for the Rust vertical.
//!
//! Tier-1 per ADR-0009: ports (as traits), cross-cutting adapters, and a test kit,
//! all satisfying the language-agnostic contract in `platform.yaml`. This is the
//! foundation scaffold; subsequent slices (epic #36) add config, the error model,
//! logging, telemetry, the HTTP edge, auth, persistence, and the conformance kit.

pub mod adapters;
pub mod api_key;
pub mod auth;
pub mod config;
pub mod domain;
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
pub mod telemetry;
pub mod testkit;
pub mod webauth;

/// The platform `contractVersion` this vertical targets (`platform.yaml`
/// `metadata.contractVersion`). A generated project records the version it targets.
pub const CONTRACT_VERSION: &str = "0.2.0";

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_matches_the_platform_contract() {
        assert_eq!(CONTRACT_VERSION, "0.2.0");
    }
}
