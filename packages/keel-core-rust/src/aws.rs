//! AWS Secrets Manager `SecretProvider` adapter (ADR-0024): one configured secret holds a JSON
//! object, and `get(name)` returns field `name` from it, coerced per ADR-0023.
//!
//! This module is only the AWS-specific loader; the caching, background refresh, fail-closed
//! construction, and no-leak serving live in the shared [`crate::secret`] core, exactly as for
//! OpenBao. ADR-0024 deliberately uses the official `aws-config` / `aws-sdk-secretsmanager` crates
//! rather than hand-rolled HTTP: SigV4 signing and the default credential chain (env, IRSA,
//! instance profile, SSO) are security-sensitive and are what the SDK implements correctly.
//!
//! The port's [`SecretProvider::get`] is synchronous and the core loads eagerly at construction,
//! but the SDK is async. So the loader owns a dedicated current-thread tokio runtime and drives
//! each `GetSecretValue` with `block_on` on the core's blocking refresh thread - never on the
//! application's async runtime, mirroring how the OpenBao refresh thread isolates its blocking
//! HTTP. Unlike OpenBao there is no token-lease logic: the SDK refreshes credentials internally,
//! so the loader leaves [`SecretLoader::next_maintenance`]/[`SecretLoader::maintain`] at their
//! defaults and the core simply re-invokes the loader every TTL.
//!
//! This whole module is gated behind the `aws` feature so the default build pulls in neither the
//! AWS SDK nor an async IO driver, mirroring the `vault` feature gating OpenBao.

use std::collections::HashMap;
use std::time::Duration;

use aws_sdk_secretsmanager::config::retry::RetryConfig;
use aws_sdk_secretsmanager::config::timeout::TimeoutConfig;
use aws_sdk_secretsmanager::error::SdkError;
use aws_sdk_secretsmanager::operation::get_secret_value::GetSecretValueOutput;
use aws_sdk_secretsmanager::Client;

use crate::ports::SecretProvider;
use crate::secret::{
    env_var, flatten_fields, parse_cache_ttl, CachingSecretProvider, SecretLoader, StartError,
};

/// Total per-operation timeout, bounding a stalled Secrets Manager endpoint. Mirrors the OpenBao
/// client's `REQUEST_TIMEOUT` and satisfies ADR-0023's "hard HTTP timeouts" rule so the eager load
/// at construction cannot hang service startup on an unreachable endpoint.
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10);
/// Connect timeout, bounding a black-holed endpoint at the TCP layer (including a wedged IMDS or
/// credential-provider hop). Mirrors the OpenBao client's `CONNECT_TIMEOUT`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Retry cap: at most two attempts, so a persistent auth/network/IMDS failure fails fast at
/// construction instead of the SDK's default exponential-backoff loop.
const MAX_RETRY_ATTEMPTS: u32 = 2;

/// Failures constructing or refreshing the AWS Secrets Manager provider. Construction errors are
/// fatal and surface fail-closed; refresh errors are logged and the last good map keeps serving.
/// No variant ever carries a secret value or credential in its message (no-leak invariant).
#[derive(Debug, thiserror::Error)]
pub enum AwsError {
    /// A missing or invalid setting (`KEEL_AWS_SECRET_ID` unset, bad shared TTL).
    #[error("aws secrets manager config error: {0}")]
    Config(String),
    /// Setting up the async runtime or the refresh thread failed.
    #[error("aws secrets manager client error: {0}")]
    Client(String),
    /// `GetSecretValue` failed for a reason other than not-found (auth, permission, network,
    /// throttling). The message is sanitized to the SDK error kind, never a response body.
    #[error("aws secrets manager load failed: {0}")]
    Load(String),
    /// The secret exists but cannot back `get(name)`: it is binary-only, or its `SecretString`
    /// is not a JSON object of fields. The malformed payload is NEVER included in the message
    /// (it is secret material), only a fixed description of the problem.
    #[error("aws secrets manager secret payload invalid: {0}")]
    Payload(String),
}

/// Resolved configuration for the AWS Secrets Manager adapter (ADR-0024).
#[derive(Debug, Clone)]
pub struct AwsSecretsConfig {
    /// The secret to read (`KEEL_AWS_SECRET_ID`): a secret name or a full ARN.
    pub secret_id: String,
    /// Region override (`KEEL_AWS_REGION`); `None` defers to the SDK's region resolution.
    pub region: Option<String>,
    /// Field-map cache TTL (shared `KEEL_SECRET_CACHE_TTL_SECONDS`, default 60s).
    pub cache_ttl: Duration,
}

impl AwsSecretsConfig {
    /// Resolve the configuration from the environment.
    ///
    /// `KEEL_AWS_SECRET_ID` gates the adapter and is required; `KEEL_AWS_REGION` is optional (else
    /// the SDK resolves the region). Credentials come from the default AWS provider chain, never
    /// from keel configuration.
    ///
    /// # Errors
    /// Returns [`AwsError::Config`] if `KEEL_AWS_SECRET_ID` is unset or the shared
    /// `KEEL_SECRET_CACHE_TTL_SECONDS` is not a positive integer.
    pub fn from_env() -> Result<Self, AwsError> {
        let secret_id = env_var("KEEL_AWS_SECRET_ID")
            .ok_or_else(|| AwsError::Config("KEEL_AWS_SECRET_ID must be set".into()))?;
        let region = env_var("KEEL_AWS_REGION");
        let cache_ttl = parse_cache_ttl().map_err(AwsError::Config)?;
        Ok(Self {
            secret_id,
            region,
            cache_ttl,
        })
    }
}

/// The AWS [`SecretLoader`]: a current-thread tokio runtime plus a lazily-built SDK client. It
/// runs only on the core's refresh thread, so none of its state needs to be `Sync`.
struct AwsLoader {
    config: AwsSecretsConfig,
    /// Drives the async SDK calls synchronously, isolated from the application's async runtime.
    runtime: tokio::runtime::Runtime,
    /// Built once on the first load via the default credential + region chain.
    client: Option<Client>,
}

impl AwsLoader {
    fn new(config: AwsSecretsConfig) -> Result<Self, AwsError> {
        // A current-thread runtime with IO + time enabled: enough to drive one hyper request to
        // Secrets Manager at a time, without the application's runtime or any worker threads.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| AwsError::Client(format!("build secrets runtime: {error}")))?;
        Ok(Self {
            config,
            runtime,
            client: None,
        })
    }

    /// Construct the loader around an already-built SDK client, bypassing the credential/region
    /// chain. Only used by the unit tests, which inject a mock client.
    #[cfg(test)]
    fn with_client(config: AwsSecretsConfig, client: Client) -> Result<Self, AwsError> {
        let mut loader = Self::new(config)?;
        loader.client = Some(client);
        Ok(loader)
    }

    /// Build the SDK client once, from the default credential chain and the resolved region. The
    /// HTTP client is set explicitly (not a default/legacy connector) so the whole SDK and the
    /// credential providers run over the modern hyper-1 + rustls-ring stack - see
    /// [`ring_https_client`].
    fn ensure_client(&mut self) -> Result<&Client, AwsError> {
        if self.client.is_none() {
            let region = self.config.region.clone();
            let client = self.runtime.block_on(async move {
                let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .http_client(ring_https_client())
                    // Hard timeouts + a retry cap so a wedged/unreachable Secrets Manager or a
                    // degraded credential/IMDS path fails fast rather than hanging the eager load
                    // at construction (ADR-0023 "hard HTTP timeouts", as on the OpenBao client).
                    .timeout_config(
                        TimeoutConfig::builder()
                            .operation_timeout(OPERATION_TIMEOUT)
                            .connect_timeout(CONNECT_TIMEOUT)
                            .build(),
                    )
                    .retry_config(RetryConfig::standard().with_max_attempts(MAX_RETRY_ATTEMPTS));
                if let Some(region) = region {
                    loader = loader.region(aws_sdk_secretsmanager::config::Region::new(region));
                }
                let shared = loader.load().await;
                Client::new(&shared)
            });
            self.client = Some(client);
        }
        Ok(self.client.as_ref().expect("client built above"))
    }
}

/// Build the modern (hyper 1.x) smithy HTTP client with rustls + ring. Used instead of any
/// default/legacy connector so the crypto backend stays on `ring` (no aws-lc-sys C build) and the
/// HTTP/2 stack resolves to the patched `h2` 0.4.x rather than the legacy hyper-0.14 / h2 0.3 path
/// (RUSTSEC-2026-0258).
fn ring_https_client() -> aws_sdk_secretsmanager::config::SharedHttpClient {
    aws_smithy_http_client::Builder::new()
        .tls_provider(aws_smithy_http_client::tls::Provider::Rustls(
            aws_smithy_http_client::tls::rustls_provider::CryptoMode::Ring,
        ))
        .build_https()
}

impl SecretLoader for AwsLoader {
    type Error = AwsError;

    fn load(&mut self) -> Result<HashMap<String, String>, AwsError> {
        let client = self.ensure_client()?.clone();
        let secret_id = self.config.secret_id.clone();
        let result = self
            .runtime
            .block_on(async move { client.get_secret_value().secret_id(secret_id).send().await });
        match result {
            Ok(output) => parse_secret_output(&output),
            // A missing secret is an empty field map (every get absent), mirroring Vault's 404.
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|service| service.is_resource_not_found_exception()) =>
            {
                Ok(HashMap::new())
            }
            Err(error) => Err(AwsError::Load(sanitize_sdk_error(&error))),
        }
    }

    fn log_load_failure(&self, error: &AwsError) {
        log_refresh_failure(error);
    }
}

/// Parse a `GetSecretValue` response into the field map (ADR-0023 coercion). The `SecretString`
/// must be a JSON object; a binary-only secret or a non-object payload fails loudly. The malformed
/// payload is never placed in the error (it is secret material).
fn parse_secret_output(output: &GetSecretValueOutput) -> Result<HashMap<String, String>, AwsError> {
    let Some(secret_string) = output.secret_string() else {
        // Binary-only (or empty) secret: it cannot back get(name), and its bytes must not leak.
        return Err(AwsError::Payload(
            "secret has no SecretString (a binary-only secret cannot back get(name); store a JSON object of fields)".into(),
        ));
    };
    let value: serde_json::Value = serde_json::from_str(secret_string).map_err(|_| {
        // Deliberately drop the serde error: it would echo the payload (the secret) into the log.
        AwsError::Payload("SecretString is not valid JSON (store a JSON object of fields)".into())
    })?;
    match value {
        serde_json::Value::Object(map) => Ok(flatten_fields(map)),
        _ => Err(AwsError::Payload(
            "SecretString is not a JSON object (store a JSON object of fields)".into(),
        )),
    }
}

/// Reduce an SDK error to a short, leak-proof message: the service error's own message (an AWS
/// exception like `AccessDeniedException`, which never carries the secret value or credentials),
/// or a generic phrase for transport-level failures. Never the raw response body.
fn sanitize_sdk_error<E, R>(error: &SdkError<E, R>) -> String
where
    E: std::fmt::Display,
{
    if let Some(service_error) = error.as_service_error() {
        format!("service error: {service_error}")
    } else {
        "could not reach or complete the Secrets Manager request".to_string()
    }
}

/// Log a failed background refresh. Only the error is recorded (`error = %error`): every
/// [`AwsError`] `Display` is leak-proof by construction (sanitized SDK errors and fixed payload
/// descriptions, never a secret value or credential), so a transient outage logs safely. Factored
/// out so the no-leak regression test can capture exactly this event.
fn log_refresh_failure(error: &AwsError) {
    tracing::warn!(error = %error, "aws secrets manager background refresh failed; serving cached secrets");
}

/// A `SecretProvider` backed by AWS Secrets Manager (ADR-0024).
///
/// A thin wrapper over the shared [`CachingSecretProvider`] core driving an [`AwsLoader`].
/// Constructed already loaded: [`AwsSecretsManagerSecretProvider::new`] performs the first
/// `GetSecretValue` before returning, so a misconfiguration (unreadable or malformed secret) fails
/// at construction and `get()` then serves synchronously from the in-memory cache with no I/O. The
/// core's background thread refreshes every `cache_ttl` and stops on drop.
pub struct AwsSecretsManagerSecretProvider {
    inner: CachingSecretProvider,
}

impl AwsSecretsManagerSecretProvider {
    /// Build the provider from the environment (see [`AwsSecretsConfig::from_env`]).
    ///
    /// # Errors
    /// Returns an [`AwsError`] if configuration is invalid or the first load fails: a not-found
    /// secret is empty (not an error), but auth failure, permission denied, or a malformed payload
    /// fails loudly at construction (fail-closed, no fall-through to the environment).
    pub fn from_env() -> Result<Self, AwsError> {
        Self::new(AwsSecretsConfig::from_env()?)
    }

    /// Build the provider from an explicit [`AwsSecretsConfig`]: resolve the SDK client, perform
    /// the initial load, and start the background refresh thread (all on the shared core's refresh
    /// thread). Construction blocks until the first load reports success or failure, so it is safe
    /// to call from within an async runtime.
    ///
    /// # Errors
    /// Returns an [`AwsError`] if the runtime/client cannot be built or the first load fails
    /// (fail-closed).
    pub fn new(config: AwsSecretsConfig) -> Result<Self, AwsError> {
        let loader = AwsLoader::new(config)?;
        Self::start(loader)
    }

    /// Construct the provider around an already-built SDK client. Only used by the unit tests.
    #[cfg(test)]
    fn with_client(config: AwsSecretsConfig, client: Client) -> Result<Self, AwsError> {
        let loader = AwsLoader::with_client(config, client)?;
        Self::start(loader)
    }

    fn start(loader: AwsLoader) -> Result<Self, AwsError> {
        let cache_ttl = loader.config.cache_ttl;
        let inner = CachingSecretProvider::start(loader, cache_ttl, "keel-aws-secrets-refresh")
            .map_err(|error| match error {
                StartError::Load(aws_error) => aws_error,
                StartError::Internal(message) => AwsError::Client(message),
            })?;
        Ok(Self { inner })
    }
}

impl SecretProvider for AwsSecretsManagerSecretProvider {
    fn get(&self, key: &str) -> Option<String> {
        self.inner.get(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_secretsmanager::config::retry::RetryConfig;
    use aws_sdk_secretsmanager::config::timeout::TimeoutConfig;
    use aws_sdk_secretsmanager::config::{BehaviorVersion, Credentials, Region};
    use aws_sdk_secretsmanager::operation::get_secret_value::GetSecretValueError;
    use aws_sdk_secretsmanager::primitives::Blob;
    use aws_sdk_secretsmanager::types::error::{
        InvalidParameterException, ResourceNotFoundException,
    };
    use aws_smithy_mocks::{
        create_mock_http_client, mock, MockResponseInterceptor, Rule, RuleMode,
    };
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    const CANARY_REGION: &str = "us-east-1";

    fn test_config() -> AwsSecretsConfig {
        AwsSecretsConfig {
            secret_id: "keel-test".to_string(),
            region: Some(CANARY_REGION.to_string()),
            // A long TTL so the background thread does not race the test with a second load.
            cache_ttl: Duration::from_secs(3600),
        }
    }

    /// Build an SDK client whose Secrets Manager operation is served entirely by `rule`, with no
    /// network and no dependence on the ambient environment. Avoids the `mock_client!` macro
    /// (which needs the SDK's `test-util` feature) by wiring the mock HTTP client + interceptor
    /// onto a fully-pinned config:
    ///
    /// - static credentials that carry an `account_id`, so account-id-based endpoint resolution is
    ///   satisfied locally and never falls through to the default credential chain (which, when an
    ///   ambient `~/.aws` profile or a reachable `169.254.169.254` exists - e.g. on the
    ///   Azure-backed GitHub runners - would otherwise hang the "preferred" account-id resolution
    ///   on a non-mocked network call; that was the 50-minute CI hang),
    /// - an explicit region, retries disabled, and a short operation timeout, so even a misrouted
    ///   request fails fast instead of hanging.
    ///
    /// Everything is set on the config (never via `std::env::set_var`, which would race the AWS
    /// SDK's concurrent `std::env::var` reads on other test threads - itself a hang), so the tests
    /// stay hermetic under parallelism.
    fn mock_client(rule: &Rule) -> Client {
        let interceptor = MockResponseInterceptor::new()
            .rule_mode(RuleMode::Sequential)
            .with_rule(rule);
        let credentials = Credentials::builder()
            .access_key_id("AKIDEXAMPLE")
            .secret_access_key("test-secret-access-key-canary")
            .account_id("000000000000")
            .provider_name("mock")
            .build();
        let config = aws_sdk_secretsmanager::config::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(credentials)
            .region(Region::new(CANARY_REGION.to_string()))
            .retry_config(RetryConfig::disabled())
            .timeout_config(
                TimeoutConfig::builder()
                    .operation_timeout(Duration::from_secs(5))
                    .build(),
            )
            .http_client(create_mock_http_client())
            .interceptor(interceptor)
            .build();
        Client::from_conf(config)
    }

    fn rule_returning(secret_string: &str) -> Rule {
        let body = secret_string.to_string();
        mock!(Client::get_secret_value)
            .match_requests(|req| req.secret_id() == Some("keel-test"))
            .then_output(move || GetSecretValueOutput::builder().secret_string(&body).build())
    }

    #[test]
    fn field_map_round_trips_and_absent_field_is_none() {
        let rule = rule_returning(r#"{"api_key": "secret-value", "other": "x"}"#);
        let provider =
            AwsSecretsManagerSecretProvider::with_client(test_config(), mock_client(&rule))
                .expect("construct against the mock");

        assert_eq!(provider.get("api_key").as_deref(), Some("secret-value"));
        assert_eq!(provider.get("other").as_deref(), Some("x"));
        assert_eq!(provider.get("missing"), None);
    }

    #[test]
    fn coercion_scalars_to_canonical_strings_and_non_scalars_absent() {
        let rule = rule_returning(
            r#"{
                "str": "plain",
                "int": 42,
                "float": 3.5,
                "bool_true": true,
                "bool_false": false,
                "obj": {"nested": "x"},
                "arr": [1, 2, 3],
                "nothing": null
            }"#,
        );
        let provider =
            AwsSecretsManagerSecretProvider::with_client(test_config(), mock_client(&rule))
                .expect("construct against the mock");

        assert_eq!(provider.get("str").as_deref(), Some("plain"));
        assert_eq!(provider.get("int").as_deref(), Some("42"));
        assert_eq!(provider.get("float").as_deref(), Some("3.5"));
        assert_eq!(provider.get("bool_true").as_deref(), Some("true"));
        assert_eq!(provider.get("bool_false").as_deref(), Some("false"));
        // Non-scalars have no flat-key representation and are dropped (absent), never serialized.
        assert_eq!(provider.get("obj"), None);
        assert_eq!(provider.get("arr"), None);
        assert_eq!(provider.get("nothing"), None);
    }

    #[test]
    fn resource_not_found_is_empty_not_an_error() {
        let rule = mock!(Client::get_secret_value).then_error(|| {
            GetSecretValueError::ResourceNotFoundException(
                ResourceNotFoundException::builder()
                    .message("Secrets Manager can't find the specified secret.")
                    .build(),
            )
        });
        // A missing secret must construct successfully (fail-open to empty, like Vault's 404).
        let provider =
            AwsSecretsManagerSecretProvider::with_client(test_config(), mock_client(&rule))
                .expect("not-found must be an empty map, not a construction error");
        assert_eq!(provider.get("anything"), None);
    }

    #[test]
    fn non_not_found_service_error_fails_closed_and_is_sanitized() {
        // Any service error other than not-found (here a permission/parameter error) must fail
        // construction loudly, never fall through to an empty map. The message is the sanitized
        // SDK error, not a response body.
        let rule = mock!(Client::get_secret_value).then_error(|| {
            GetSecretValueError::InvalidParameterException(
                InvalidParameterException::builder()
                    .message("the parameter name or value is invalid")
                    .build(),
            )
        });
        let error =
            AwsSecretsManagerSecretProvider::with_client(test_config(), mock_client(&rule)).err();
        assert!(
            matches!(error, Some(AwsError::Load(_))),
            "a non-not-found service error must fail construction: {error:?}",
        );
    }

    #[test]
    fn binary_only_secret_fails_closed() {
        let rule = mock!(Client::get_secret_value).then_output(|| {
            GetSecretValueOutput::builder()
                .secret_binary(Blob::new(b"\x00\x01\x02 binary bytes".to_vec()))
                .build()
        });
        // Discard a surprise Ok(provider) (not Debug) so only the error is formatted on failure.
        let error =
            AwsSecretsManagerSecretProvider::with_client(test_config(), mock_client(&rule)).err();
        assert!(
            matches!(error, Some(AwsError::Payload(_))),
            "a binary-only secret must fail construction: {error:?}",
        );
    }

    #[test]
    fn non_object_payload_fails_closed() {
        for payload in [r#""just a bare string""#, "not json at all {", "[1, 2, 3]"] {
            let rule = rule_returning(payload);
            let error =
                AwsSecretsManagerSecretProvider::with_client(test_config(), mock_client(&rule))
                    .err();
            assert!(
                matches!(error, Some(AwsError::Payload(_))),
                "payload {payload:?} must fail construction: {error:?}",
            );
        }
    }

    #[test]
    fn malformed_payload_error_never_leaks_the_secret_or_credentials() {
        // The realistic leak vector: a JSON/parse error echoing the payload (the secret) into the
        // log. CANARY_SECRET is the payload; the sanitized error and the refresh-failure log line
        // must contain neither it nor the static test credential.
        const CANARY_SECRET: &str = "super-secret-leak-canary-value-9f3a";
        const CANARY_CRED: &str = "test-secret-access-key-canary";

        // A non-object payload whose text is the canary: parsing fails and the error must NOT
        // include the payload bytes.
        let payload = format!("this-is-not-json {CANARY_SECRET}");
        let rule = rule_returning(&payload);
        let mut loader = AwsLoader::with_client(test_config(), mock_client(&rule))
            .expect("build the loader with the mock client");
        let error = loader
            .load()
            .expect_err("a malformed payload must fail the load");

        // The error's own Display must not carry the secret.
        let rendered = error.to_string();
        assert!(
            !rendered.contains(CANARY_SECRET),
            "the error message leaked the secret payload: {rendered:?}",
        );

        // Capture exactly the refresh-failure log event via a thread-local subscriber.
        let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(LogBufferWriter(Arc::clone(&buffer)))
            .with_max_level(tracing::Level::DEBUG)
            .finish();
        tracing::subscriber::with_default(subscriber, || log_refresh_failure(&error));

        let text =
            String::from_utf8(buffer.lock().expect("log buffer lock").clone()).expect("utf8 logs");
        assert!(
            text.contains("aws secrets manager background refresh failed"),
            "the refresh-failure path must have logged (capture sanity): {text:?}",
        );
        assert!(
            !text.contains(CANARY_SECRET),
            "the secret payload must never appear in any log line: {text:?}",
        );
        assert!(
            !text.contains(CANARY_CRED),
            "a credential must never appear in any log line: {text:?}",
        );
    }

    /// A `MakeWriter` capturing every emitted log line into a shared buffer.
    #[derive(Clone)]
    struct LogBufferWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for LogBufferWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("log buffer lock")
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBufferWriter {
        type Writer = LogBufferWriter;

        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }
}
