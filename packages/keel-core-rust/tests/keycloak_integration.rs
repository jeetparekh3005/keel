//! OidcAuthenticator against a real Keycloak (epic #419, v0.6 parity).
//!
//! Mirrors the Python vertical's `test_keycloak_integration.py`: it mints a real
//! service-account token via `client_credentials`, then verifies it through the real
//! `OidcAuthenticator` backed by a `JwksCache` that fetches the LIVE JWKS over HTTP.
//! This exercises the real remote-fetch path ([`JwksCache::refresh`]), not an injected
//! key, so it proves the JWKS resolver, RS256 verification, and issuer/audience checks
//! all agree with what Keycloak actually issues.
//!
//! Gated the same way as the Rust Postgres integration test: it is `#[ignore]`d so a
//! plain `cargo test` reports it as "ignored" rather than silently passing; CI runs it
//! with `--include-ignored` after starting a Keycloak container and setting the env.
//! Running it without `KEEL_KEYCLOAK_URL` fails loudly (the `expect` below) instead of
//! reporting a false pass.

use keel_core::auth::{Authenticator, OidcAuthenticator};
use keel_core::jwks::JwksCache;

/// Clock-skew leeway for the live token's `exp`/`nbf`, in seconds.
const LEEWAY_SECS: u64 = 60;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::test]
#[ignore = "integration: requires KEEL_KEYCLOAK_URL (Keycloak); run with `cargo test -- --include-ignored`"]
async fn authenticates_a_real_keycloak_token() {
    let base_url = std::env::var("KEEL_KEYCLOAK_URL")
        .expect("KEEL_KEYCLOAK_URL must be set to run this integration test");
    let realm = env_or("KEEL_KEYCLOAK_REALM", "keel");
    let client_id = env_or("KEEL_KEYCLOAK_CLIENT_ID", "keel-api");
    let client_secret = env_or("KEEL_KEYCLOAK_CLIENT_SECRET", "test-secret");
    let audience = env_or("KEEL_OIDC_AUDIENCE", "keel-api");

    let realm_base = format!("{base_url}/realms/{realm}");
    let token_url = format!("{realm_base}/protocol/openid-connect/token");
    let jwks_uri = format!("{realm_base}/protocol/openid-connect/certs");

    // Mint a real service-account access token via the client_credentials grant.
    let http = reqwest::Client::new();
    let token: String = http
        .post(&token_url)
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
        ])
        .send()
        .await
        .expect("token request to Keycloak")
        .error_for_status()
        .expect("Keycloak token endpoint returned a non-2xx status")
        .json::<serde_json::Value>()
        .await
        .expect("token response is JSON")
        .get("access_token")
        .and_then(serde_json::Value::as_str)
        .expect("token response contains an access_token")
        .to_string();

    // Build the real JWKS cache and fetch the LIVE key set (the remote-fetch path).
    // Local Keycloak is plaintext http, so allow_insecure is required here.
    let cache = JwksCache::new(&jwks_uri, true).expect("build jwks cache");
    cache
        .refresh()
        .await
        .expect("fetch the live JWKS from Keycloak");

    // Verify the minted token through the real authenticator, resolving its signing key
    // from the cache populated by the live fetch above.
    let authenticator =
        OidcAuthenticator::new(&realm_base, &audience, LEEWAY_SECS, cache.resolver());
    let principal = authenticator
        .authenticate(&token)
        .expect("the live Keycloak token verifies against the live JWKS");

    // The service account has a stable subject (the service-account user id).
    assert!(
        !principal.subject.is_empty(),
        "a verified Keycloak token must carry a non-empty subject",
    );
}
