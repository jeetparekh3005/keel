//! AwsSecretsManagerSecretProvider against a real Secrets Manager endpoint (ADR-0024).
//!
//! Mirrors the OpenBao integration test and the Rust NATS/Keycloak pattern: upsert a JSON secret
//! on the live endpoint, then read it back through the adapter, proving the credential + load +
//! cache path end to end against a genuine Secrets Manager API.
//!
//! Gated like the other integration tests: the file compiles only under the `aws` feature, and the
//! test is `#[ignore]`d so a plain `cargo test` reports it "ignored" rather than silently passing.
//! CI runs it with `--include-ignored` after starting a LocalStack Secrets Manager container and
//! setting `KEEL_AWS_SECRET_ID` / `AWS_ENDPOINT_URL_SECRETS_MANAGER` / `AWS_*` credentials. Running
//! it without `KEEL_AWS_SECRET_ID` fails loudly (the `require_env` below), never a false pass.

#![cfg(feature = "aws")]

use keel_core::aws::AwsSecretsManagerSecretProvider;
use keel_core::ports::SecretProvider;

fn require_env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("{key} must be set to run this integration test"))
}

#[test]
#[ignore = "integration: requires KEEL_AWS_SECRET_ID (LocalStack/AWS Secrets Manager); run with `cargo test --features aws -- --include-ignored`"]
fn writes_then_reads_back_a_json_secret_through_the_adapter() {
    let secret_id = require_env("KEEL_AWS_SECRET_ID");
    // Region resolution mirrors the adapter: KEEL_AWS_REGION if set, else a sensible default for
    // LocalStack. The SDK honors AWS_ENDPOINT_URL_SECRETS_MANAGER for the endpoint.
    let region = std::env::var("KEEL_AWS_REGION")
        .ok()
        .or_else(|| Some("us-east-1".to_string()));

    let expected = format!("value-{}", uuid::Uuid::new_v4().simple());
    let payload = serde_json::json!({ "api_key": expected }).to_string();

    // Upsert the JSON secret directly via the SDK on a dedicated current-thread runtime (the same
    // isolation the adapter uses), so repeated runs update rather than collide.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build setup runtime");
    runtime.block_on(async {
        let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest());
        if let Some(region) = &region {
            loader = loader.region(aws_sdk_secretsmanager::config::Region::new(region.clone()));
        }
        let shared = loader.load().await;
        let client = aws_sdk_secretsmanager::Client::new(&shared);

        // Create the secret, or update it to a new version if it already exists.
        let created = client
            .create_secret()
            .name(&secret_id)
            .secret_string(&payload)
            .send()
            .await;
        if created.is_err() {
            client
                .put_secret_value()
                .secret_id(&secret_id)
                .secret_string(&payload)
                .send()
                .await
                .expect("put a new secret version");
        }
    });

    // Read it back through the adapter via the env factory (exercises AwsSecretsConfig::from_env
    // and the full from_env -> new -> load path): resolve the client, eager load, serve from cache.
    let provider = AwsSecretsManagerSecretProvider::from_env()
        .expect("construct the AWS provider against the live endpoint");

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
