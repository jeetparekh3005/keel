//! OpenBaoSecretProvider against a real OpenBao (or HashiCorp Vault) KV v2 server (ADR-0023).
//!
//! Mirrors the other verticals' OpenBao integration test and the Rust NATS/Keycloak pattern:
//! write a KV v2 secret to the live server, then read it back through the adapter, proving the
//! authenticate + load + cache path end to end against a genuine Vault HTTP API.
//!
//! Gated like the NATS/Postgres/Keycloak integration tests: the whole file compiles only under
//! the `vault` feature, and the test is `#[ignore]`d so a plain `cargo test` reports it as
//! "ignored" rather than silently passing. CI runs it with `--include-ignored` after starting
//! an `openbao` dev server and setting `KEEL_VAULT_ADDR`/`KEEL_VAULT_TOKEN`/etc. Running it
//! without `KEEL_VAULT_ADDR` fails loudly (the `expect` below), never a false pass.

#![cfg(feature = "vault")]

use keel_core::ports::SecretProvider;
use keel_core::vault::{OpenBaoSecretProvider, VaultAuth, VaultConfig};
use std::time::Duration;

fn require_env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("{key} must be set to run this integration test"))
}

#[test]
#[ignore = "integration: requires KEEL_VAULT_ADDR (OpenBao/Vault); run with `cargo test --features vault -- --include-ignored`"]
fn writes_then_reads_back_a_kv_v2_secret_through_the_adapter() {
    let addr = require_env("KEEL_VAULT_ADDR");
    let addr = addr.trim_end_matches('/').to_string();
    let token = require_env("KEEL_VAULT_TOKEN");
    let mount = std::env::var("KEEL_VAULT_MOUNT").unwrap_or_else(|_| "secret".to_string());
    // A unique path per run so repeated runs never collide on a stale value.
    let base_path = std::env::var("KEEL_VAULT_PATH").unwrap_or_else(|_| "keel-test".to_string());
    let path = format!("{base_path}-{}", uuid::Uuid::new_v4().simple());

    let expected = format!("value-{}", uuid::Uuid::new_v4().simple());

    // Write the KV v2 secret directly over the HTTP API with the root token.
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("build write client");
    let write_url = format!("{addr}/v1/{mount}/data/{path}");
    let write = client
        .post(&write_url)
        .header("X-Vault-Token", &token)
        .json(&serde_json::json!({ "data": { "api_key": expected } }))
        .send()
        .expect("write the KV v2 secret");
    assert!(
        write.status().is_success(),
        "writing the secret should succeed, got {} ({write_url})",
        write.status(),
    );

    // Read it back through the adapter: authenticate (token), eager load, serve from cache.
    let provider = OpenBaoSecretProvider::new(VaultConfig {
        addr: addr.clone(),
        auth: VaultAuth::Token(token.clone()),
        mount,
        path,
        namespace: std::env::var("KEEL_VAULT_NAMESPACE").ok(),
        cacert: std::env::var("KEEL_VAULT_CACERT").ok(),
        cache_ttl: Duration::from_secs(60),
    })
    .expect("construct the OpenBao provider against the live server");

    assert_eq!(
        provider.get("api_key").as_deref(),
        Some(expected.as_str()),
        "the written secret must round-trip through the adapter",
    );
    assert_eq!(
        provider.get("not-a-field"),
        None,
        "an absent field reads as None (the port's not-found signal)",
    );
}
