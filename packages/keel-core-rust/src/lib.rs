//! keel-core-rust: the shared platform library for the Rust vertical.
//!
//! Tier-1 per ADR-0009: ports (as traits), cross-cutting adapters, and a test kit,
//! all satisfying the language-agnostic contract in `platform.yaml`. This is the
//! foundation scaffold; subsequent slices (epic #36) add config, the error model,
//! logging, telemetry, the HTTP edge, auth, persistence, and the conformance kit.

pub mod auth;
pub mod config;
pub mod domain;
pub mod http;
pub mod logging;
pub mod persistence;

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
