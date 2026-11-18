//! GCP Secret Manager `SecretProvider` adapter (ADR-0024): one configured secret holds a JSON
//! object, and `get(name)` returns field `name` from it, coerced per ADR-0023.
//!
//! This module is only the GCP-specific loader; the caching, background refresh, fail-closed
//! construction, and no-leak serving live in the shared [`crate::secret`] core, exactly as for
//! OpenBao and AWS. ADR-0024 deliberately uses an official-style SDK rather than hand-rolled HTTP:
//! GCP OAuth2 / Application Default Credentials (env, Workload Identity, metadata server) are
//! security-sensitive and are what the SDK resolves correctly.
//!
//! The Rust vertical uses the `gcloud-sdk` crate rather than the google-cloud-rust
//! `google-cloud-secretmanager-v1` crate the other verticals use: that crate's
//! `google-cloud-auth` hard-wires `aws-lc-rs` (a C/assembly crypto build) plus `native-tls`, with
//! no `ring` path, which violates keel's rustls/no-openssl posture. `gcloud-sdk`, configured with
//! no bundled TLS feature plus `reqwest`'s `rustls-no-provider` and `tonic/tls-ring`, resolves to
//! a ring-only tree (no `aws-lc-sys`, no `openssl`, no `native-tls`). See ADR-0024.
//!
//! Because `reqwest`'s `rustls-no-provider` ships no default crypto provider, the adapter installs
//! the process-global `ring` provider once (idempotently) before building any client; see
//! [`install_ring_crypto_provider`].
//!
//! The port's [`SecretProvider::get`] is synchronous and the core loads eagerly at construction,
//! but the SDK is async. So the loader owns a dedicated current-thread tokio runtime and drives
//! each `AccessSecretVersion` with `block_on` on the core's blocking refresh thread - never on the
//! application's async runtime, mirroring how the AWS loader isolates its blocking SDK calls.
//! Unlike OpenBao there is no token-lease logic: the SDK refreshes credentials internally, so the
//! loader leaves [`SecretLoader::next_maintenance`]/[`SecretLoader::maintain`] at their defaults
//! and the core simply re-invokes the loader every TTL.
//!
//! This whole module is gated behind the `gcp` feature so the default build pulls in neither the
//! GCP SDK nor an async IO driver, mirroring the `aws` and `vault` features.

use std::collections::HashMap;
use std::time::Duration;

use gcloud_sdk::google::cloud::secretmanager::v1::secret_manager_service_client::SecretManagerServiceClient;
use gcloud_sdk::google::cloud::secretmanager::v1::AccessSecretVersionRequest;
use gcloud_sdk::{GoogleApi, GoogleAuthMiddleware};

use crate::ports::SecretProvider;
use crate::secret::{
    env_var, flatten_fields, parse_cache_ttl, CachingSecretProvider, SecretLoader, StartError,
};

/// The production Secret Manager gRPC endpoint. Tests never use it: they inject a mock endpoint
/// with static credentials (see [`GcpLoader::with_mock`]).
const SECRET_MANAGER_ENDPOINT: &str = "https://secretmanager.googleapis.com";
/// Default secret version when `KEEL_GCP_SECRET_VERSION` is unset (ADR-0024).
const DEFAULT_SECRET_VERSION: &str = "latest";
/// Total per-operation timeout, bounding a stalled Secret Manager endpoint or a degraded
/// ADC/metadata path. Mirrors the AWS loader's `OPERATION_TIMEOUT` and satisfies ADR-0023's "hard
/// timeouts" rule so the eager load at construction (and each client build) cannot hang service
/// startup on an unreachable endpoint.
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10);

/// The resolved Secret Manager client, built once over the shared caching core's refresh thread.
type SecretManagerApi = GoogleApi<SecretManagerServiceClient<GoogleAuthMiddleware>>;

/// Failures constructing or refreshing the GCP Secret Manager provider. Construction errors are
/// fatal and surface fail-closed; refresh errors are logged and the last good map keeps serving.
/// No variant ever carries a secret value or credential in its message (no-leak invariant).
#[derive(Debug, thiserror::Error)]
pub enum GcpError {
    /// A missing or invalid setting (`KEEL_GCP_SECRET` unset, bad shared TTL).
    #[error("gcp secret manager config error: {0}")]
    Config(String),
    /// Setting up the async runtime or building the SDK client (ADC resolution, channel connect)
    /// failed. The message is a fixed, sanitized description, never an ADC token or endpoint body.
    #[error("gcp secret manager client error: {0}")]
    Client(String),
    /// `AccessSecretVersion` failed for a reason other than not-found (auth, permission denied,
    /// network, timeout). The message is sanitized to the gRPC status code, never a response body.
    #[error("gcp secret manager load failed: {0}")]
    Load(String),
    /// The secret exists but cannot back `get(name)`: its payload is empty, not UTF-8, or not a
    /// JSON object of fields. The malformed payload is NEVER included in the message (it is secret
    /// material), only a fixed description of the problem.
    #[error("gcp secret manager secret payload invalid: {0}")]
    Payload(String),
}

/// Resolved configuration for the GCP Secret Manager adapter (ADR-0024).
#[derive(Debug, Clone)]
pub struct GcpSecretsConfig {
    /// The fully-qualified `AccessSecretVersion` resource name
    /// (`projects/<p>/secrets/<name>/versions/<v>`), resolved from `KEEL_GCP_SECRET` and
    /// `KEEL_GCP_SECRET_VERSION`.
    pub resource: String,
    /// Field-map cache TTL (shared `KEEL_SECRET_CACHE_TTL_SECONDS`, default 60s).
    pub cache_ttl: Duration,
}

impl GcpSecretsConfig {
    /// Resolve the configuration from the environment.
    ///
    /// `KEEL_GCP_SECRET` gates the adapter and is required: it is either a secret
    /// (`projects/<p>/secrets/<name>`), to which `/versions/<KEEL_GCP_SECRET_VERSION>` (default
    /// `latest`) is appended, or already a full version resource (`.../versions/<v>`), used as-is.
    /// Credentials come from Application Default Credentials, never from keel configuration.
    ///
    /// # Errors
    /// Returns [`GcpError::Config`] if `KEEL_GCP_SECRET` is unset or the shared
    /// `KEEL_SECRET_CACHE_TTL_SECONDS` is not a positive integer.
    pub fn from_env() -> Result<Self, GcpError> {
        let secret = env_var("KEEL_GCP_SECRET")
            .ok_or_else(|| GcpError::Config("KEEL_GCP_SECRET must be set".into()))?;
        let version = env_var("KEEL_GCP_SECRET_VERSION")
            .unwrap_or_else(|| DEFAULT_SECRET_VERSION.to_string());
        let cache_ttl = parse_cache_ttl().map_err(GcpError::Config)?;
        Ok(Self {
            resource: resource_name(&secret, &version),
            cache_ttl,
        })
    }
}

/// Resolve the `AccessSecretVersion` resource name: if `secret` already names a version
/// (`.../versions/<v>`), use it verbatim; otherwise append `/versions/<version>`.
fn resource_name(secret: &str, version: &str) -> String {
    if secret.contains("/versions/") {
        secret.to_string()
    } else {
        format!("{}/versions/{}", secret.trim_end_matches('/'), version)
    }
}

/// Install the process-global `ring` rustls crypto provider exactly once.
///
/// `reqwest`'s `rustls-no-provider` feature (used by `gcloud-sdk`'s `google-cloud-auth` for the
/// ADC token calls) ships no default crypto provider, so the application must install one; keel
/// installs `ring` to keep the whole tree off `aws-lc-rs`/`aws-lc-sys` (ADR-0024). `install_default`
/// errors if a provider is already set (another backend, a test, or a prior call did it); that is
/// the benign "already installed" case and is ignored, so this is safe under parallel tests.
fn install_ring_crypto_provider() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// How the loader obtains its client: the production ADC path, or a test mock (a plaintext
/// loopback endpoint plus a static bearer token, so tests resolve no real ADC, hit no metadata
/// server, and open no external socket).
enum ClientSource {
    /// Application Default Credentials against the real Secret Manager endpoint.
    Adc,
    /// A mock endpoint URL plus a static bearer token (tests only).
    #[cfg(test)]
    Mock { endpoint: String, token: String },
}

/// The GCP [`SecretLoader`]: a current-thread tokio runtime plus a lazily-built SDK client. It
/// runs only on the core's refresh thread, so none of its state needs to be `Sync`.
struct GcpLoader {
    config: GcpSecretsConfig,
    /// Drives the async SDK calls synchronously, isolated from the application's async runtime.
    runtime: tokio::runtime::Runtime,
    /// Built once on the first load via ADC (or the injected mock).
    client: Option<SecretManagerApi>,
    /// Where the client comes from (ADC in production, a mock in tests).
    source: ClientSource,
    /// Per-operation timeout (client build + each RPC). A field, not a const, so a test can make
    /// the bounded-timeout path fire quickly.
    timeout: Duration,
}

impl GcpLoader {
    fn new(config: GcpSecretsConfig) -> Result<Self, GcpError> {
        Self::build(config, ClientSource::Adc, OPERATION_TIMEOUT)
    }

    /// Construct the loader around a mock endpoint + static bearer token, bypassing ADC and the
    /// metadata server entirely. Only used by the unit tests.
    #[cfg(test)]
    fn with_mock(
        config: GcpSecretsConfig,
        endpoint: String,
        token: String,
        timeout: Duration,
    ) -> Result<Self, GcpError> {
        Self::build(config, ClientSource::Mock { endpoint, token }, timeout)
    }

    fn build(
        config: GcpSecretsConfig,
        source: ClientSource,
        timeout: Duration,
    ) -> Result<Self, GcpError> {
        // A current-thread runtime with IO + time enabled: enough to drive one gRPC request to
        // Secret Manager at a time, without the application's runtime or any worker threads.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| GcpError::Client(format!("build secrets runtime: {error}")))?;
        Ok(Self {
            config,
            runtime,
            client: None,
            source,
            timeout,
        })
    }

    /// Build the SDK client once, bounded by [`Self::timeout`] so a wedged endpoint or a degraded
    /// ADC/metadata path fails fast at construction rather than hanging the eager load.
    fn ensure_client(&mut self) -> Result<&SecretManagerApi, GcpError> {
        if self.client.is_none() {
            // The ring provider must be installed before any TLS (prod) client is built.
            install_ring_crypto_provider();
            let timeout = self.timeout;
            let built = self.runtime.block_on(async {
                tokio::time::timeout(timeout, build_client(&self.source)).await
            });
            let client = match built {
                Ok(Ok(client)) => client,
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err(GcpError::Client(
                    "timed out building the Secret Manager client (endpoint or ADC unreachable)"
                        .into(),
                )),
            };
            self.client = Some(client);
        }
        Ok(self.client.as_ref().expect("client built above"))
    }
}

/// Build the Secret Manager client for the given source. Production uses ADC against the real
/// endpoint; a mock uses static bearer credentials against a loopback endpoint.
async fn build_client(source: &ClientSource) -> Result<SecretManagerApi, GcpError> {
    match source {
        ClientSource::Adc => {
            GoogleApi::from_function(SecretManagerServiceClient::new, SECRET_MANAGER_ENDPOINT, None)
                .await
                .map_err(|_| {
                    GcpError::Client(
                        "could not build the Secret Manager client (check ADC credentials and connectivity)"
                            .into(),
                    )
                })
        }
        #[cfg(test)]
        ClientSource::Mock { endpoint, token } => {
            let credentials = gcloud_sdk::google_cloud_auth::credentials::Credentials::from(
                tests::StaticBearerCredentials::new(token.clone()),
            );
            GoogleApi::from_function_with_credentials(
                SecretManagerServiceClient::new,
                endpoint.clone(),
                None,
                credentials,
            )
            .await
            .map_err(|_| GcpError::Client("could not build the mock Secret Manager client".into()))
        }
    }
}

impl SecretLoader for GcpLoader {
    type Error = GcpError;

    fn load(&mut self) -> Result<HashMap<String, String>, GcpError> {
        self.ensure_client()?;
        let client = self.client.as_ref().expect("client built above").clone();
        let resource = self.config.resource.clone();
        let timeout = self.timeout;
        let result = self.runtime.block_on(async move {
            let mut service = client.get();
            let request = AccessSecretVersionRequest { name: resource };
            tokio::time::timeout(timeout, service.access_secret_version(request)).await
        });
        match result {
            Ok(Ok(response)) => parse_secret_response(response.into_inner()),
            // A missing secret is an empty field map (every get absent), mirroring Vault's 404.
            Ok(Err(status)) if status.code() == gcloud_sdk::tonic::Code::NotFound => {
                Ok(HashMap::new())
            }
            Ok(Err(status)) => Err(GcpError::Load(sanitize_status(&status))),
            Err(_) => Err(GcpError::Load(
                "access secret version request timed out".into(),
            )),
        }
    }

    fn log_load_failure(&self, error: &GcpError) {
        log_refresh_failure(error);
    }
}

/// Parse an `AccessSecretVersion` response into the field map (ADR-0023 coercion). The payload
/// bytes must be UTF-8 and a JSON object; an empty/binary/non-object payload fails loudly. The
/// malformed payload is never placed in the error (it is secret material).
fn parse_secret_response(
    response: gcloud_sdk::google::cloud::secretmanager::v1::AccessSecretVersionResponse,
) -> Result<HashMap<String, String>, GcpError> {
    let Some(payload) = response.payload else {
        return Err(GcpError::Payload(
            "response carried no payload (store a JSON object of fields)".into(),
        ));
    };
    let bytes = payload.data.ref_sensitive_value().clone();
    let text = String::from_utf8(bytes).map_err(|_| {
        // Drop the bytes: they are the secret, and must not reach the log via the error.
        GcpError::Payload(
            "secret payload is not valid UTF-8 (store a JSON object of fields)".into(),
        )
    })?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        // Deliberately drop the serde error: it would echo the payload (the secret).
        GcpError::Payload("secret payload is not valid JSON (store a JSON object of fields)".into())
    })?;
    match value {
        serde_json::Value::Object(map) => Ok(flatten_fields(map)),
        _ => Err(GcpError::Payload(
            "secret payload is not a JSON object (store a JSON object of fields)".into(),
        )),
    }
}

/// Reduce a gRPC status to a short, leak-proof message: its code only (an enum like
/// `PermissionDenied`), never the status message or any response body, so a secret value or
/// credential can never reach the log through a refresh failure.
fn sanitize_status(status: &gcloud_sdk::tonic::Status) -> String {
    format!("request failed with status {:?}", status.code())
}

/// Log a failed background refresh. Only the error is recorded (`error = %error`): every
/// [`GcpError`] `Display` is leak-proof by construction (sanitized status codes and fixed payload
/// descriptions, never a secret value or credential), so a transient outage logs safely. Factored
/// out so the no-leak regression test can capture exactly this event.
fn log_refresh_failure(error: &GcpError) {
    tracing::warn!(error = %error, "gcp secret manager background refresh failed; serving cached secrets");
}

/// A `SecretProvider` backed by GCP Secret Manager (ADR-0024).
///
/// A thin wrapper over the shared [`CachingSecretProvider`] core driving a [`GcpLoader`].
/// Constructed already loaded: [`GcpSecretManagerSecretProvider::new`] performs the first
/// `AccessSecretVersion` before returning, so a misconfiguration (unreadable or malformed secret)
/// fails at construction and `get()` then serves synchronously from the in-memory cache with no
/// I/O. The core's background thread refreshes every `cache_ttl` and stops on drop.
pub struct GcpSecretManagerSecretProvider {
    inner: CachingSecretProvider,
}

impl GcpSecretManagerSecretProvider {
    /// Build the provider from the environment (see [`GcpSecretsConfig::from_env`]).
    ///
    /// # Errors
    /// Returns a [`GcpError`] if configuration is invalid or the first load fails: a not-found
    /// secret is empty (not an error), but auth failure, permission denied, or a malformed payload
    /// fails loudly at construction (fail-closed, no fall-through to the environment).
    pub fn from_env() -> Result<Self, GcpError> {
        Self::new(GcpSecretsConfig::from_env()?)
    }

    /// Build the provider from an explicit [`GcpSecretsConfig`]: resolve the SDK client via ADC,
    /// perform the initial load, and start the background refresh thread (all on the shared core's
    /// refresh thread). Construction blocks until the first load reports success or failure, so it
    /// is safe to call from within an async runtime.
    ///
    /// # Errors
    /// Returns a [`GcpError`] if the runtime/client cannot be built or the first load fails
    /// (fail-closed).
    pub fn new(config: GcpSecretsConfig) -> Result<Self, GcpError> {
        let loader = GcpLoader::new(config)?;
        Self::start(loader)
    }

    /// Construct the provider around a mock endpoint + static bearer token. Only used by the unit
    /// tests (no ADC, no metadata server, no external socket).
    #[cfg(test)]
    fn with_mock(
        config: GcpSecretsConfig,
        endpoint: String,
        token: String,
        timeout: Duration,
    ) -> Result<Self, GcpError> {
        let loader = GcpLoader::with_mock(config, endpoint, token, timeout)?;
        Self::start(loader)
    }

    fn start(loader: GcpLoader) -> Result<Self, GcpError> {
        let cache_ttl = loader.config.cache_ttl;
        let inner = CachingSecretProvider::start(loader, cache_ttl, "keel-gcp-secrets-refresh")
            .map_err(|error| match error {
                StartError::Load(gcp_error) => gcp_error,
                StartError::Internal(message) => GcpError::Client(message),
            })?;
        Ok(Self { inner })
    }
}

impl SecretProvider for GcpSecretManagerSecretProvider {
    fn get(&self, key: &str) -> Option<String> {
        self.inner.get(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gcloud_sdk::google::cloud::secretmanager::v1::AccessSecretVersionResponse;
    use gcloud_sdk::google_cloud_auth::credentials::{
        CacheableResource, CredentialsProvider, EntityTag,
    };
    use gcloud_sdk::google_cloud_auth::errors::CredentialsError;
    use gcloud_sdk::proto_ext::secretmanager::SecretPayload;
    use gcloud_sdk::SecretValue;
    use http::header::{HeaderMap, HeaderValue, AUTHORIZATION};
    use http::Extensions;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use tokio_stream::wrappers::TcpListenerStream;

    const TEST_RESOURCE: &str = "projects/keel-test/secrets/app/versions/latest";
    /// A short timeout for the bounded-timeout test, so the hang path fires in well under a second.
    const SHORT_TIMEOUT: Duration = Duration::from_millis(250);

    fn test_config() -> GcpSecretsConfig {
        GcpSecretsConfig {
            resource: TEST_RESOURCE.to_string(),
            // A long TTL so the background thread does not race the test with a second load.
            cache_ttl: Duration::from_secs(3600),
        }
    }

    /// Static bearer credentials: serve `authorization: Bearer {token}` with no network, no ADC,
    /// and no metadata-server probe. Wrapped into `google_cloud_auth::credentials::Credentials` via
    /// its `From<CredentialsProvider>` so the client authenticates entirely locally.
    #[derive(Debug, Clone)]
    pub(super) struct StaticBearerCredentials {
        token: String,
    }

    impl StaticBearerCredentials {
        pub(super) fn new(token: String) -> Self {
            Self { token }
        }
    }

    impl CredentialsProvider for StaticBearerCredentials {
        async fn headers(
            &self,
            _extensions: Extensions,
        ) -> Result<CacheableResource<HeaderMap>, CredentialsError> {
            let mut headers = HeaderMap::new();
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", self.token)).expect("valid bearer"),
            );
            Ok(CacheableResource::New {
                entity_tag: EntityTag::new(),
                data: headers,
            })
        }

        async fn universe_domain(&self) -> Option<String> {
            None
        }
    }

    /// How the mock answers `AccessSecretVersion`.
    #[derive(Clone)]
    enum MockBehavior {
        /// Return a payload whose bytes are this string.
        Payload(String),
        /// Return `NOT_FOUND` (the empty-map signal).
        NotFound,
        /// Return this gRPC status code (a non-not-found failure).
        Failed(gcloud_sdk::tonic::Code),
        /// Never answer, so the client's per-RPC timeout fires.
        Hang,
    }

    /// An in-process tonic Secret Manager mock on a loopback port. It answers `AccessSecretVersion`
    /// from a single [`MockBehavior`] and records nothing else; every other method is unimplemented
    /// (the adapter only ever calls `AccessSecretVersion`). Runs on its own runtime on a dedicated
    /// thread so it can serve while the loader's runtime blocks on the call.
    struct MockSecretManager {
        endpoint: String,
        shutdown: Option<tokio::sync::oneshot::Sender<()>>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl MockSecretManager {
        fn start(behavior: MockBehavior) -> Self {
            // Bind synchronously so the port is known before the client connects (no bind race).
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock");
            let addr = listener.local_addr().expect("mock addr");
            listener.set_nonblocking(true).expect("nonblocking");
            let endpoint = format!("http://{addr}");
            let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

            let handle = std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("mock runtime");
                runtime.block_on(async move {
                    let listener =
                        tokio::net::TcpListener::from_std(listener).expect("tokio listener");
                    let service = MockService {
                        behavior: Arc::new(behavior),
                    };
                    let serve = gcloud_sdk::tonic::transport::Server::builder()
                        .add_service(service)
                        .serve_with_incoming(TcpListenerStream::new(listener));
                    // Forceful (not graceful) shutdown: on the signal, drop the serve future and
                    // let the runtime drop abort any in-flight request. A graceful shutdown would
                    // instead wait for in-flight requests to drain - and the `Hang` behavior holds
                    // one open forever, which would deadlock the drop-time join.
                    tokio::select! {
                        _ = serve => {}
                        _ = shutdown_rx => {}
                    }
                });
            });

            Self {
                endpoint,
                shutdown: Some(shutdown_tx),
                handle: Some(handle),
            }
        }

        fn endpoint(&self) -> String {
            self.endpoint.clone()
        }
    }

    impl Drop for MockSecretManager {
        fn drop(&mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    /// A tonic service that routes every `SecretManagerService` call to a single unary
    /// `AccessSecretVersion` handler driven by [`MockBehavior`]. Mirrors how gcloud-sdk's own tests
    /// hand-roll a unary service via [`gcloud_sdk::tonic::server::Grpc`], avoiding the full
    /// generated server trait (the adapter calls only `AccessSecretVersion`).
    #[derive(Clone)]
    struct MockService {
        behavior: Arc<MockBehavior>,
    }

    impl gcloud_sdk::tonic::server::NamedService for MockService {
        const NAME: &'static str = "google.cloud.secretmanager.v1.SecretManagerService";
    }

    impl tower::Service<http::Request<gcloud_sdk::tonic::body::Body>> for MockService {
        type Response = http::Response<gcloud_sdk::tonic::body::Body>;
        type Error = std::convert::Infallible;
        type Future = std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>,
        >;

        fn poll_ready(
            &mut self,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn call(&mut self, request: http::Request<gcloud_sdk::tonic::body::Body>) -> Self::Future {
            let behavior = Arc::clone(&self.behavior);
            let handler = tower::service_fn(
                move |req: gcloud_sdk::tonic::Request<AccessSecretVersionRequest>| {
                    let behavior = Arc::clone(&behavior);
                    async move {
                        match &*behavior {
                            MockBehavior::Payload(body) => Ok(gcloud_sdk::tonic::Response::new(
                                AccessSecretVersionResponse {
                                    name: req.into_inner().name,
                                    payload: Some(SecretPayload {
                                        data: SecretValue::new(body.clone().into_bytes()),
                                        data_crc32c: None,
                                    }),
                                },
                            )),
                            MockBehavior::NotFound => Err(gcloud_sdk::tonic::Status::not_found(
                                "secret version not found",
                            )),
                            MockBehavior::Failed(code) => {
                                Err(gcloud_sdk::tonic::Status::new(*code, "mock failure"))
                            }
                            MockBehavior::Hang => {
                                std::future::pending::<()>().await;
                                unreachable!()
                            }
                        }
                    }
                },
            );
            Box::pin(async move {
                let codec = tonic_prost::ProstCodec::<
                    AccessSecretVersionResponse,
                    AccessSecretVersionRequest,
                >::default();
                let mut grpc = gcloud_sdk::tonic::server::Grpc::new(codec);
                Ok(grpc.unary(handler, request).await)
            })
        }
    }

    /// Build a provider against a mock serving `behavior`, with the default (long) timeout.
    fn provider_for(
        behavior: MockBehavior,
    ) -> (
        MockSecretManager,
        Result<GcpSecretManagerSecretProvider, GcpError>,
    ) {
        let mock = MockSecretManager::start(behavior);
        let provider = GcpSecretManagerSecretProvider::with_mock(
            test_config(),
            mock.endpoint(),
            "mock-bearer-token".to_string(),
            OPERATION_TIMEOUT,
        );
        (mock, provider)
    }

    #[test]
    fn field_map_round_trips_and_absent_field_is_none() {
        let (_mock, provider) = provider_for(MockBehavior::Payload(
            r#"{"api_key": "secret-value", "other": "x"}"#.to_string(),
        ));
        let provider = provider.expect("construct against the mock");

        assert_eq!(provider.get("api_key").as_deref(), Some("secret-value"));
        assert_eq!(provider.get("other").as_deref(), Some("x"));
        assert_eq!(provider.get("missing"), None);
    }

    #[test]
    fn coercion_scalars_to_canonical_strings_and_non_scalars_absent() {
        let (_mock, provider) = provider_for(MockBehavior::Payload(
            r#"{
                "str": "plain",
                "int": 42,
                "float": 3.5,
                "bool_true": true,
                "bool_false": false,
                "obj": {"nested": "x"},
                "arr": [1, 2, 3],
                "nothing": null
            }"#
            .to_string(),
        ));
        let provider = provider.expect("construct against the mock");

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
    fn not_found_is_empty_not_an_error() {
        let (_mock, provider) = provider_for(MockBehavior::NotFound);
        // A missing secret must construct successfully (fail-open to empty, like Vault's 404).
        let provider = provider.expect("not-found must be an empty map, not a construction error");
        assert_eq!(provider.get("anything"), None);
    }

    #[test]
    fn non_not_found_status_fails_closed_and_is_sanitized() {
        // Any status other than not-found (here permission denied) must fail construction loudly,
        // never fall through to an empty map. The message is the sanitized status code.
        let (_mock, provider) = provider_for(MockBehavior::Failed(
            gcloud_sdk::tonic::Code::PermissionDenied,
        ));
        let error = provider.err();
        assert!(
            matches!(error, Some(GcpError::Load(_))),
            "a non-not-found status must fail construction: {error:?}",
        );
    }

    #[test]
    fn non_object_payload_fails_closed() {
        for payload in [r#""just a bare string""#, "not json at all {", "[1, 2, 3]"] {
            let (_mock, provider) = provider_for(MockBehavior::Payload(payload.to_string()));
            let error = provider.err();
            assert!(
                matches!(error, Some(GcpError::Payload(_))),
                "payload {payload:?} must fail construction: {error:?}",
            );
        }
    }

    #[test]
    fn non_utf8_payload_fails_closed() {
        // A genuinely non-UTF-8 payload must fail on the UTF-8 step, without echoing the bytes.
        // Driven through the parse path directly (a mock cannot carry raw invalid-UTF-8 through a
        // Rust string literal).
        let response = AccessSecretVersionResponse {
            name: TEST_RESOURCE.to_string(),
            payload: Some(SecretPayload {
                data: SecretValue::new(vec![0xff, 0xfe, 0x00, b'{']),
                data_crc32c: None,
            }),
        };
        let error = parse_secret_response(response).err();
        assert!(
            matches!(error, Some(GcpError::Payload(_))),
            "a non-UTF-8 payload must fail closed: {error:?}",
        );
    }

    #[test]
    fn empty_payload_fails_closed() {
        // A response with no payload message cannot back get(name) and must fail loudly.
        let response = AccessSecretVersionResponse {
            name: TEST_RESOURCE.to_string(),
            payload: None,
        };
        let error = parse_secret_response(response).err();
        assert!(
            matches!(error, Some(GcpError::Payload(_))),
            "a payload-less response must fail closed: {error:?}",
        );
    }

    #[test]
    fn bounded_timeout_makes_a_wedged_endpoint_fail_fast() {
        let mock = MockSecretManager::start(MockBehavior::Hang);
        let started = std::time::Instant::now();
        let error = GcpSecretManagerSecretProvider::with_mock(
            test_config(),
            mock.endpoint(),
            "mock-bearer-token".to_string(),
            SHORT_TIMEOUT,
        )
        .err();
        let elapsed = started.elapsed();
        assert!(
            matches!(error, Some(GcpError::Load(_))),
            "a wedged endpoint must fail construction with a Load (timeout) error: {error:?}",
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "the bounded timeout must fail fast, took {elapsed:?}",
        );
    }

    #[test]
    fn malformed_payload_error_never_leaks_the_secret_or_credentials() {
        // The realistic leak vector: a parse error echoing the payload (the secret) into the log.
        // CANARY_SECRET is the payload; the sanitized error and the refresh-failure log line must
        // contain neither it nor the static bearer token.
        const CANARY_SECRET: &str = "super-secret-leak-canary-value-9f3a";
        const CANARY_TOKEN: &str = "canary-bearer-token-7b2e";

        let payload = format!("this-is-not-json {CANARY_SECRET}");
        let mock = MockSecretManager::start(MockBehavior::Payload(payload));
        let mut loader = GcpLoader::with_mock(
            test_config(),
            mock.endpoint(),
            CANARY_TOKEN.to_string(),
            OPERATION_TIMEOUT,
        )
        .expect("build the loader against the mock");
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
            text.contains("gcp secret manager background refresh failed"),
            "the refresh-failure path must have logged (capture sanity): {text:?}",
        );
        assert!(
            !text.contains(CANARY_SECRET),
            "the secret payload must never appear in any log line: {text:?}",
        );
        assert!(
            !text.contains(CANARY_TOKEN),
            "a credential must never appear in any log line: {text:?}",
        );
    }

    #[test]
    fn resource_name_appends_version_or_uses_a_full_version_verbatim() {
        assert_eq!(
            resource_name("projects/p/secrets/app", "latest"),
            "projects/p/secrets/app/versions/latest",
        );
        assert_eq!(
            resource_name("projects/p/secrets/app/", "3"),
            "projects/p/secrets/app/versions/3",
        );
        assert_eq!(
            resource_name("projects/p/secrets/app/versions/7", "latest"),
            "projects/p/secrets/app/versions/7",
            "a full version resource is used verbatim",
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
