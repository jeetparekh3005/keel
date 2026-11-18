//! GcpSecretManagerSecretProvider against a real Secret Manager endpoint (ADR-0024).
//!
//! GCP has no official Secret Manager emulator, so (unlike the AWS LocalStack test) this runs only
//! where real Application Default Credentials and a pre-provisioned JSON secret exist. It is the one
//! backend without a CI-run integration test (ADR-0024 "Testing"); its unit coverage in `src/gcp.rs`
//! is correspondingly thorough (round-trip, coercion, not-found-as-empty, fail-closed, no-leak, and
//! the bounded-timeout path, all hermetic).
//!
//! Gated like the other integration tests: the file compiles only under the `gcp` feature, and the
//! test is `#[ignore]`d so a plain `cargo test` reports it "ignored" rather than silently passing.
//! Run it where ADC is present with:
//!   KEEL_GCP_SECRET=projects/<p>/secrets/<name> \
//!   KEEL_GCP_EXPECTED_FIELD=<field> KEEL_GCP_EXPECTED_VALUE=<value> \
//!   cargo test --features gcp -- --include-ignored
//! The secret must hold a JSON object; the adapter returns field `KEEL_GCP_EXPECTED_FIELD`. Running
//! it without `KEEL_GCP_SECRET` fails loudly (the `require_env` below), never a false pass.

#![cfg(feature = "gcp")]

use keel_core::gcp::GcpSecretManagerSecretProvider;
use keel_core::ports::SecretProvider;

fn require_env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("{key} must be set to run this integration test"))
}

#[test]
#[ignore = "integration: requires KEEL_GCP_SECRET + real ADC (no GCP emulator); run with `cargo test --features gcp -- --include-ignored`"]
fn reads_back_a_json_secret_field_through_the_adapter() {
    // Gating var must be present (the adapter also reads it via from_env); fail loudly otherwise.
    let _secret = require_env("KEEL_GCP_SECRET");
    let field = require_env("KEEL_GCP_EXPECTED_FIELD");
    let expected = require_env("KEEL_GCP_EXPECTED_VALUE");

    // Build through the env factory (exercises GcpSecretsConfig::from_env and the full
    // from_env -> new -> load path): resolve ADC, build the client, eager load, serve from cache.
    let provider = GcpSecretManagerSecretProvider::from_env()
        .expect("construct the GCP provider against the live endpoint");

    assert_eq!(
        provider.get(&field).as_deref(),
        Some(expected.as_str()),
        "the provisioned secret field must round-trip through the adapter",
    );
    assert_eq!(
        provider.get("keel-not-a-field-xyz"),
        None,
        "an absent field reads as None (the port's not-found signal)",
    );
}
