//! OpenBao `SecretProvider` adapter (ADR-0023): static KV v2 read over the Vault HTTP API.
//!
//! The identical wire protocol serves OpenBao and HashiCorp Vault, so this one adapter
//! covers either endpoint unchanged. The port's [`SecretProvider::get`] is synchronous and
//! must never perform I/O, so the adapter authenticates and loads the KV v2 field map into
//! an in-memory cache once at construction, then serves `get()` from that cache under a
//! `RwLock`. A background `std::thread` re-loads the path every `KEEL_VAULT_CACHE_TTL_SECONDS`
//! and, when the auth method issues a lease, proactively re-logs in a skew before the token
//! expires (not only reactively on a `401/403`, which it still handles by re-authenticating -
//! Kubernetes re-login; a static token surfaces the error - and retrying once). A failed refresh
//! keeps serving the last good map and logs, so a transient OpenBao outage does not take the
//! service down.
//!
//! Selection is fail-closed: [`secret_provider_from_env`] returns this provider when
//! `KEEL_VAULT_ADDR` is set and fails loudly on misconfiguration (missing auth, unreachable
//! server, missing path) rather than silently falling back to the environment; with
//! `KEEL_VAULT_ADDR` unset it returns the dev [`EnvSecretProvider`].
//!
//! All blocking HTTP (the eager initial load and the periodic refresh) runs on the dedicated
//! refresh thread, never on the caller's thread, so construction is safe to invoke from
//! within an async runtime even though it blocks until the first load completes.
//!
//! This whole module is gated behind the `vault` feature (it enables `reqwest/blocking`);
//! the default core build stays env-only, exactly like the `nats` feature gating the broker.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Deserialize;

use crate::adapters::EnvSecretProvider;
use crate::ports::SecretProvider;

/// Default Kubernetes auth mount path when `KEEL_VAULT_K8S_MOUNT` is unset.
const DEFAULT_K8S_MOUNT: &str = "kubernetes";
/// Default service-account JWT file when `KEEL_VAULT_K8S_JWT_PATH` is unset.
const DEFAULT_K8S_JWT_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";
/// Default KV v2 mount when `KEEL_VAULT_MOUNT` is unset.
const DEFAULT_MOUNT: &str = "secret";
/// Default field-map cache TTL when `KEEL_VAULT_CACHE_TTL_SECONDS` is unset.
const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(60);
/// Total request timeout (bounds a stalled OpenBao endpoint).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Connect timeout (bounds a black-holed endpoint at the TCP layer).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Fraction of a token's lease to let elapse before proactively re-logging in: renew once
/// two-thirds of the lease is gone, leaving a third as skew so a short-lived token is replaced
/// before expiry rather than only reactively on a 401/403. Scaling with the lease keeps a tiny
/// lease from re-logging in a tight loop while still refreshing a long lease comfortably early.
const RENEW_LEASE_FRACTION: f64 = 2.0 / 3.0;
/// Back-off before retrying a failed proactive re-login, so a flapping auth endpoint is not
/// hammered; the reactive 401/403 retry still covers the token actually lapsing in between.
const RENEW_RETRY_BACKOFF: Duration = Duration::from_secs(5);

/// Failures constructing or refreshing the provider. Construction errors are fatal and
/// surface fail-closed; refresh errors are logged and the last good map keeps serving.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    /// A missing or invalid `KEEL_VAULT_*` setting (no auth, no path, bad TTL).
    #[error("vault config error: {0}")]
    Config(String),
    /// Building the HTTP client (e.g. a bad `KEEL_VAULT_CACERT`) failed.
    #[error("vault http client build: {0}")]
    Client(String),
    /// Authenticating (static token invalid, Kubernetes login failed) failed.
    #[error("vault authentication failed: {0}")]
    Auth(String),
    /// Reading the KV v2 path failed (server unreachable, unexpected status, bad body).
    #[error("vault read failed: {0}")]
    Read(String),
}

/// How the adapter obtains a client token (ADR-0023: token or Kubernetes, in that order).
#[derive(Debug, Clone)]
pub enum VaultAuth {
    /// A static client token (`KEEL_VAULT_TOKEN`); used directly, no login.
    Token(String),
    /// Kubernetes auth: log in with a service-account JWT to obtain a client token.
    Kubernetes {
        /// The Kubernetes auth role name (`KEEL_VAULT_ROLE`).
        role: String,
        /// The Kubernetes auth mount path (`KEEL_VAULT_K8S_MOUNT`).
        mount: String,
        /// Path to the service-account JWT file (`KEEL_VAULT_K8S_JWT_PATH`).
        jwt_path: String,
    },
}

/// Resolved `KEEL_VAULT_*` configuration for the adapter.
#[derive(Debug, Clone)]
pub struct VaultConfig {
    /// Base URL, e.g. `https://openbao:8200` (trailing slash trimmed).
    pub addr: String,
    /// The resolved authentication method.
    pub auth: VaultAuth,
    /// KV v2 mount (`KEEL_VAULT_MOUNT`, default `secret`).
    pub mount: String,
    /// Secret path under the mount (`KEEL_VAULT_PATH`).
    pub path: String,
    /// `X-Vault-Namespace` header value (`KEEL_VAULT_NAMESPACE`), if any.
    pub namespace: Option<String>,
    /// CA for TLS verification (`KEEL_VAULT_CACERT`): a PEM literal or a file path.
    pub cacert: Option<String>,
    /// Field-map cache TTL (`KEEL_VAULT_CACHE_TTL_SECONDS`, default 60s).
    pub cache_ttl: Duration,
}

impl VaultConfig {
    /// Resolve the configuration from the `KEEL_VAULT_*` environment variables.
    ///
    /// `KEEL_VAULT_ADDR` must be set (it is what gates the adapter) and `KEEL_VAULT_PATH`
    /// is required. Exactly one auth method must be configured: `KEEL_VAULT_TOKEN` takes
    /// precedence, else `KEEL_VAULT_ROLE` selects Kubernetes auth; neither is a fatal
    /// misconfiguration (fail-closed, no environment fallback).
    ///
    /// # Errors
    /// Returns [`VaultError::Config`] if `KEEL_VAULT_ADDR`/`KEEL_VAULT_PATH` is unset, no
    /// auth is configured, or `KEEL_VAULT_CACHE_TTL_SECONDS` is not a valid number.
    pub fn from_env() -> Result<Self, VaultError> {
        let addr = env_var("KEEL_VAULT_ADDR")
            .ok_or_else(|| VaultError::Config("KEEL_VAULT_ADDR must be set".into()))?;
        let addr = addr.trim_end_matches('/').to_string();
        let path = env_var("KEEL_VAULT_PATH")
            .ok_or_else(|| VaultError::Config("KEEL_VAULT_PATH is required".into()))?;
        let mount = env_var("KEEL_VAULT_MOUNT").unwrap_or_else(|| DEFAULT_MOUNT.to_string());
        let namespace = env_var("KEEL_VAULT_NAMESPACE");
        let cacert = env_var("KEEL_VAULT_CACERT");
        let cache_ttl = match env_var("KEEL_VAULT_CACHE_TTL_SECONDS") {
            Some(raw) => {
                // A non-positive or unparseable TTL is a fatal misconfiguration, not a value to
                // clamp: silently serving a 1s cache would hammer OpenBao and hide the typo.
                let seconds: u64 =
                    raw.parse()
                        .ok()
                        .filter(|seconds| *seconds > 0)
                        .ok_or_else(|| {
                            VaultError::Config(format!(
                            "KEEL_VAULT_CACHE_TTL_SECONDS must be a positive integer, got {raw:?}"
                        ))
                        })?;
                Duration::from_secs(seconds)
            }
            None => DEFAULT_CACHE_TTL,
        };

        // Token first, then Kubernetes (ADR-0023 auth order); neither set is fail-closed.
        let auth = if let Some(token) = env_var("KEEL_VAULT_TOKEN") {
            VaultAuth::Token(token)
        } else if let Some(role) = env_var("KEEL_VAULT_ROLE") {
            VaultAuth::Kubernetes {
                role,
                mount: env_var("KEEL_VAULT_K8S_MOUNT")
                    .unwrap_or_else(|| DEFAULT_K8S_MOUNT.to_string()),
                jwt_path: env_var("KEEL_VAULT_K8S_JWT_PATH")
                    .unwrap_or_else(|| DEFAULT_K8S_JWT_PATH.to_string()),
            }
        } else {
            return Err(VaultError::Config(
                "KEEL_VAULT_ADDR is set but no auth is configured (set KEEL_VAULT_TOKEN or KEEL_VAULT_ROLE)".into(),
            ));
        };

        Ok(Self {
            addr,
            auth,
            mount,
            path,
            namespace,
            cacert,
            cache_ttl,
        })
    }
}

/// Read an environment variable, treating empty as unset and trimming surrounding whitespace.
fn env_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The outcome of one KV v2 read: the (possibly empty) field map, or an auth challenge.
enum ReadOutcome {
    /// The field map at the path (empty for a 404 - every `get` is absent, not an error).
    Fields(HashMap<String, String>),
    /// A `401`/`403`: the caller should re-authenticate and retry once.
    Unauthorized,
}

/// KV v2 read response shape: the field map lives at the `.data.data` JSON pointer.
#[derive(Deserialize)]
struct KvV2Response {
    data: KvV2Data,
}

#[derive(Deserialize)]
struct KvV2Data {
    #[serde(default)]
    data: serde_json::Map<String, serde_json::Value>,
}

/// Kubernetes login response: the client token lives at `.auth.client_token` and its lease
/// (seconds until the token expires) at `.auth.lease_duration`.
#[derive(Deserialize)]
struct LoginResponse {
    auth: LoginAuth,
}

#[derive(Deserialize)]
struct LoginAuth {
    client_token: String,
    /// Seconds the issued token is valid for; `0` (or absent) means no finite lease, so the
    /// token is never proactively renewed.
    #[serde(default)]
    lease_duration: u64,
}

/// A resolved client token plus, when the auth method issues one, the token's lease. A static
/// token has no lease (`None`) and is never proactively renewed; a Kubernetes login carries the
/// lease so the refresh thread can re-login before the token expires.
struct AuthResult {
    token: String,
    lease: Option<Duration>,
}

/// A `SecretProvider` backed by OpenBao (or HashiCorp Vault) over the KV v2 HTTP API.
///
/// Constructed already loaded: [`OpenBaoSecretProvider::new`] authenticates and performs the
/// first read before returning, so a misconfiguration fails at construction and `get()` then
/// serves synchronously from the in-memory cache with no I/O. A background thread refreshes
/// the cache every `cache_ttl`; [`Drop`] stops and joins it.
pub struct OpenBaoSecretProvider {
    /// The cached KV v2 field map; the only thing `get()` touches.
    cache: Arc<RwLock<HashMap<String, String>>>,
    /// Stop flag + condvar used to wake and end the refresh thread promptly on drop.
    stop: Arc<(Mutex<bool>, Condvar)>,
    /// The refresh thread handle, joined on drop.
    handle: Option<JoinHandle<()>>,
}

impl OpenBaoSecretProvider {
    /// Build the provider from the `KEEL_VAULT_*` environment (see [`VaultConfig::from_env`]).
    ///
    /// # Errors
    /// Returns a [`VaultError`] if configuration is invalid or the first authenticate/read
    /// fails (fail-closed: no fall-through to the environment).
    pub fn from_env() -> Result<Self, VaultError> {
        Self::new(VaultConfig::from_env()?)
    }

    /// Build the provider from an explicit [`VaultConfig`]: authenticate, perform the initial
    /// load, and start the background refresh thread.
    ///
    /// All HTTP runs on the refresh thread; construction blocks until the first load reports
    /// success or failure, so it is safe to call from within an async runtime.
    ///
    /// # Errors
    /// Returns a [`VaultError`] if building the client, authenticating, or the first read
    /// fails (fail-closed).
    pub fn new(config: VaultConfig) -> Result<Self, VaultError> {
        let cache: Arc<RwLock<HashMap<String, String>>> = Arc::new(RwLock::new(HashMap::new()));
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        // One-shot channel the refresh thread uses to report the result of the eager load,
        // so construction fails closed if auth or the first read fails.
        let (init_tx, init_rx) = mpsc::channel::<Result<(), VaultError>>();

        let thread_cache = Arc::clone(&cache);
        let thread_stop = Arc::clone(&stop);
        let handle = std::thread::Builder::new()
            .name("keel-vault-refresh".to_string())
            .spawn(move || {
                refresh_thread(config, thread_cache, thread_stop, init_tx);
            })
            .map_err(|error| VaultError::Client(format!("spawn refresh thread: {error}")))?;

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                cache,
                stop,
                handle: Some(handle),
            }),
            Ok(Err(error)) => {
                // The thread finished after reporting the failure; join it so no thread leaks.
                let _ = handle.join();
                Err(error)
            }
            Err(_) => {
                let _ = handle.join();
                Err(VaultError::Config(
                    "vault refresh thread terminated before reporting the initial load".into(),
                ))
            }
        }
    }
}

impl SecretProvider for OpenBaoSecretProvider {
    fn get(&self, key: &str) -> Option<String> {
        // A pure cache read: no I/O on the request path. A poisoned lock (a writer panicked)
        // reports absent rather than propagating the panic through the port.
        self.cache
            .read()
            .ok()
            .and_then(|fields| fields.get(key).cloned())
    }
}

impl Drop for OpenBaoSecretProvider {
    fn drop(&mut self) {
        let (lock, cvar) = &*self.stop;
        if let Ok(mut stopping) = lock.lock() {
            *stopping = true;
        }
        cvar.notify_all();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// The refresh thread body: build the client, authenticate, perform the eager initial load
/// (reporting its result back to construction), then re-load every `cache_ttl` and proactively
/// re-login before the token's lease expires, until stopped.
fn refresh_thread(
    config: VaultConfig,
    cache: Arc<RwLock<HashMap<String, String>>>,
    stop: Arc<(Mutex<bool>, Condvar)>,
    init_tx: mpsc::Sender<Result<(), VaultError>>,
) {
    let client = match build_client(config.cacert.as_deref()) {
        Ok(client) => client,
        Err(error) => {
            let _ = init_tx.send(Err(error));
            return;
        }
    };

    // A static token is used as-is; Kubernetes auth logs in once here for the first token.
    let auth = match authenticate(&client, &config) {
        Ok(auth) => auth,
        Err(error) => {
            let _ = init_tx.send(Err(error));
            return;
        }
    };
    // When the token carries a lease, schedule the first proactive re-login; a static token
    // (no lease) is never proactively renewed, so `renew_at` stays `None`.
    let mut renew_at = auth
        .lease
        .map(|lease| renew_deadline(std::time::Instant::now(), lease));
    let token_state = Mutex::new(auth.token);

    match load(&client, &config, &token_state) {
        Ok(fields) => {
            if let Ok(mut writable) = cache.write() {
                *writable = fields;
            }
            let _ = init_tx.send(Ok(()));
        }
        Err(error) => {
            let _ = init_tx.send(Err(error));
            return;
        }
    }

    // Periodic work: refresh the field-map every `cache_ttl` and, independently, proactively
    // re-login a skew before the token's lease expires. The thread sleeps until the nearer of
    // the two deadlines (or the stop signal), so a short lease is renewed well before the cache
    // would otherwise refresh.
    let (lock, cvar) = &*stop;
    let mut next_refresh = std::time::Instant::now() + config.cache_ttl;
    loop {
        let now = std::time::Instant::now();
        let wake_at = match renew_at {
            Some(renew) => next_refresh.min(renew),
            None => next_refresh,
        };
        let wait = wake_at.saturating_duration_since(now);
        let stopping = {
            let Ok(guard) = lock.lock() else { break };
            let (guard, _timeout) = match cvar.wait_timeout(guard, wait) {
                Ok(result) => result,
                Err(_) => break,
            };
            *guard
        };
        if stopping {
            break;
        }

        let now = std::time::Instant::now();
        // Proactive token renewal: re-login before the lease lapses, independently of the
        // field-map cache refresh, so a short-lived token never expires out from under us.
        if let Some(renew) = renew_at {
            if now >= renew {
                match authenticate(&client, &config) {
                    Ok(fresh) => {
                        if let Ok(mut guard) = token_state.lock() {
                            *guard = fresh.token;
                        }
                        renew_at = fresh
                            .lease
                            .map(|lease| renew_deadline(std::time::Instant::now(), lease));
                    }
                    Err(error) => {
                        // Keep the current token and try again shortly; the reactive 401/403
                        // retry still covers the token actually lapsing before then.
                        tracing::warn!(error = %error, "openbao proactive token renewal failed; will retry");
                        renew_at = Some(now + RENEW_RETRY_BACKOFF);
                    }
                }
            }
        }

        if now >= next_refresh {
            match load(&client, &config, &token_state) {
                Ok(fields) => {
                    if let Ok(mut writable) = cache.write() {
                        *writable = fields;
                    }
                }
                Err(error) => {
                    // A transient outage must not take the service down: keep the last good map.
                    log_refresh_failure(&error);
                }
            }
            next_refresh = std::time::Instant::now() + config.cache_ttl;
        }
    }
}

/// Log a failed background refresh. Only the error is recorded (`error = %error`): every
/// [`VaultError`] `Display` carries config/URL context but never a token, JWT, or secret value,
/// so a transient outage logs safely. Factored out so the no-leak regression test can capture
/// exactly this event without racing the process-global logging subscriber.
fn log_refresh_failure(error: &VaultError) {
    tracing::warn!(error = %error, "openbao background refresh failed; serving cached secrets");
}

/// Build the blocking HTTP client, trusting `KEEL_VAULT_CACERT` in addition to the system
/// roots when set (a PEM literal or a file path).
fn build_client(cacert: Option<&str>) -> Result<reqwest::blocking::Client, VaultError> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT);
    if let Some(cacert) = cacert {
        let pem = load_cacert(cacert)?;
        let certificate = reqwest::Certificate::from_pem(&pem)
            .map_err(|error| VaultError::Client(format!("parse KEEL_VAULT_CACERT: {error}")))?;
        builder = builder.add_root_certificate(certificate);
    }
    builder
        .build()
        .map_err(|error| VaultError::Client(error.to_string()))
}

/// Resolve `KEEL_VAULT_CACERT` to PEM bytes: an inline PEM literal is used directly, anything
/// else is treated as a file path and read.
fn load_cacert(cacert: &str) -> Result<Vec<u8>, VaultError> {
    if cacert.contains("BEGIN CERTIFICATE") {
        Ok(cacert.as_bytes().to_vec())
    } else {
        std::fs::read(cacert).map_err(|error| {
            VaultError::Client(format!("read KEEL_VAULT_CACERT {cacert}: {error}"))
        })
    }
}

/// Resolve a client token (with its lease, when the method issues one): a static token directly,
/// else a Kubernetes login.
fn authenticate(
    client: &reqwest::blocking::Client,
    config: &VaultConfig,
) -> Result<AuthResult, VaultError> {
    match &config.auth {
        VaultAuth::Token(token) => Ok(AuthResult {
            token: token.clone(),
            lease: None,
        }),
        VaultAuth::Kubernetes {
            role,
            mount,
            jwt_path,
        } => {
            let jwt = std::fs::read_to_string(jwt_path)
                .map_err(|error| VaultError::Auth(format!("read JWT {jwt_path}: {error}")))?;
            let url = format!("{}/v1/auth/{}/login", config.addr, mount);
            let mut request = client
                .post(&url)
                .json(&serde_json::json!({ "role": role, "jwt": jwt.trim() }));
            if let Some(namespace) = &config.namespace {
                request = request.header("X-Vault-Namespace", namespace);
            }
            let response = request
                .send()
                .map_err(|error| VaultError::Auth(format!("kubernetes login request: {error}")))?;
            let status = response.status().as_u16();
            if !(200..300).contains(&status) {
                return Err(VaultError::Auth(format!(
                    "kubernetes login to {url} returned status {status}"
                )));
            }
            let body: LoginResponse = response
                .json()
                .map_err(|error| VaultError::Auth(format!("decode login response: {error}")))?;
            let lease = (body.auth.lease_duration > 0)
                .then(|| Duration::from_secs(body.auth.lease_duration));
            Ok(AuthResult {
                token: body.auth.client_token,
                lease,
            })
        }
    }
}

/// When to proactively re-login given a token issued now with `lease`: once
/// [`RENEW_LEASE_FRACTION`] of the lease has elapsed.
fn renew_deadline(issued_at: std::time::Instant, lease: Duration) -> std::time::Instant {
    issued_at + lease.mul_f64(RENEW_LEASE_FRACTION)
}

/// Read the KV v2 field map once with `token`, mapping statuses per ADR-0023.
fn read_fields(
    client: &reqwest::blocking::Client,
    config: &VaultConfig,
    token: &str,
) -> Result<ReadOutcome, VaultError> {
    let url = format!("{}/v1/{}/data/{}", config.addr, config.mount, config.path);
    let mut request = client.get(&url).header("X-Vault-Token", token);
    if let Some(namespace) = &config.namespace {
        request = request.header("X-Vault-Namespace", namespace);
    }
    let response = request
        .send()
        .map_err(|error| VaultError::Read(format!("read {url}: {error}")))?;
    match response.status().as_u16() {
        200 => {
            let body: KvV2Response = response
                .json()
                .map_err(|error| VaultError::Read(format!("decode {url}: {error}")))?;
            Ok(ReadOutcome::Fields(flatten_fields(body.data.data)))
        }
        // A missing secret is an empty field map (every get absent), the same as an empty env.
        404 => Ok(ReadOutcome::Fields(HashMap::new())),
        401 | 403 => Ok(ReadOutcome::Unauthorized),
        other => Err(VaultError::Read(format!(
            "unexpected status {other} reading {url}"
        ))),
    }
}

/// Load the field map, re-authenticating and retrying once on a `401`/`403`.
fn load(
    client: &reqwest::blocking::Client,
    config: &VaultConfig,
    token_state: &Mutex<String>,
) -> Result<HashMap<String, String>, VaultError> {
    let token = token_state
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| VaultError::Auth("token state lock poisoned".into()))?;
    match read_fields(client, config, &token)? {
        ReadOutcome::Fields(fields) => Ok(fields),
        ReadOutcome::Unauthorized => {
            // Re-authenticate (Kubernetes re-login; a static token just re-presents itself and
            // will surface a persistent 403 below) and retry the read exactly once.
            let fresh = authenticate(client, config)?.token;
            if let Ok(mut guard) = token_state.lock() {
                *guard = fresh.clone();
            }
            match read_fields(client, config, &fresh)? {
                ReadOutcome::Fields(fields) => Ok(fields),
                ReadOutcome::Unauthorized => Err(VaultError::Auth(
                    "still unauthorized after re-authentication".into(),
                )),
            }
        }
    }
}

/// Flatten the KV v2 `.data.data` object into string fields (ADR-0023 field coercion):
/// a scalar is coerced to its canonical string (a string passes through, a number becomes its
/// JSON text, a boolean becomes `"true"`/`"false"`); a non-scalar (object, array, or null) has
/// no canonical flat-key representation and is dropped, so `get()` reports it absent rather than
/// returning serialized JSON a caller would mistake for the secret value.
fn flatten_fields(data: serde_json::Map<String, serde_json::Value>) -> HashMap<String, String> {
    data.into_iter()
        .filter_map(|(key, value)| {
            let coerced = match value {
                serde_json::Value::String(text) => Some(text),
                serde_json::Value::Number(number) => Some(number.to_string()),
                serde_json::Value::Bool(flag) => Some(flag.to_string()),
                serde_json::Value::Object(_)
                | serde_json::Value::Array(_)
                | serde_json::Value::Null => None,
            };
            coerced.map(|value| (key, value))
        })
        .collect()
}

/// Select the production secret provider fail-closed: the OpenBao adapter when
/// `KEEL_VAULT_ADDR` is set, else the dev [`EnvSecretProvider`]. Boxed as
/// `Arc<dyn SecretProvider>` for the service composition root (ADR-0023 "Selection and wiring").
///
/// # Errors
/// Returns a [`VaultError`] when `KEEL_VAULT_ADDR` is set but the OpenBao provider cannot be
/// built (bad config, auth failure, unreachable server): the service fails to start rather
/// than silently reading secrets from the environment.
pub fn secret_provider_from_env() -> Result<Arc<dyn SecretProvider>, VaultError> {
    if env_var("KEEL_VAULT_ADDR").is_some() {
        Ok(Arc::new(OpenBaoSecretProvider::from_env()?))
    } else {
        Ok(Arc::new(EnvSecretProvider))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// One request captured by [`MockVault`].
    #[derive(Clone)]
    struct RecordedRequest {
        method: String,
        path: String,
        headers: HashMap<String, String>,
        body: String,
    }

    /// A canned response a handler returns for a request.
    struct MockResponse {
        status: u16,
        body: String,
    }

    impl MockResponse {
        fn ok(body: &str) -> Self {
            Self {
                status: 200,
                body: body.to_string(),
            }
        }
    }

    type Handler = Arc<dyn Fn(&RecordedRequest) -> MockResponse + Send + Sync>;

    /// A hand-rolled single-connection HTTP/1.1 mock of the Vault API, so the unit tests need
    /// no network dependency and can assert exact request shape (path, headers, body) and
    /// sequence responses (404, 403-then-200) via handler state. Each connection carries one
    /// request; `Connection: close` makes reqwest open a fresh connection per request, so the
    /// recorded request count equals the upstream request count.
    struct MockVault {
        addr: String,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    impl MockVault {
        fn start(handler: Handler) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock vault");
            let addr = format!("http://{}", listener.local_addr().unwrap());
            listener
                .set_nonblocking(true)
                .expect("nonblocking mock listener");
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));

            let thread_requests = Arc::clone(&requests);
            let thread_stop = Arc::clone(&stop);
            let handle = std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if thread_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    match stream {
                        Ok(mut stream) => {
                            if let Some(request) = read_request(&mut stream) {
                                thread_requests.lock().unwrap().push(request.clone());
                                let response = handler(&request);
                                let payload = format!(
                                    "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    response.status,
                                    response.body.len(),
                                    response.body,
                                );
                                let _ = stream.write_all(payload.as_bytes());
                                let _ = stream.flush();
                            }
                        }
                        Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });

            Self {
                addr,
                requests,
                stop,
                handle: Some(handle),
            }
        }

        fn requests(&self) -> Vec<RecordedRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for MockVault {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Nudge the accept loop out of its WouldBlock sleep with a throwaway connection.
            if let Ok(addr) = self
                .addr
                .trim_start_matches("http://")
                .parse::<std::net::SocketAddr>()
            {
                let _ = std::net::TcpStream::connect(addr);
            }
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    /// Read one HTTP/1.1 request off the stream: the request line, headers, and a body sized
    /// by `Content-Length`.
    fn read_request(stream: &mut std::net::TcpStream) -> Option<RecordedRequest> {
        stream.set_nonblocking(false).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        // Read until the end of the header block.
        let header_end = loop {
            if let Some(index) = find_subslice(&buffer, b"\r\n\r\n") {
                break index;
            }
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
        };

        let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let mut lines = header_text.split("\r\n");
        let request_line = lines.next()?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next()?.to_string();
        let path = parts.next()?.to_string();

        let mut headers = HashMap::new();
        let mut content_length = 0usize;
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim().to_lowercase();
                let value = value.trim().to_string();
                if name == "content-length" {
                    content_length = value.parse().unwrap_or(0);
                }
                headers.insert(name, value);
            }
        }

        // The body may already be partly in `buffer` after the header terminator.
        let mut body = buffer[header_end + 4..].to_vec();
        while body.len() < content_length {
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read]);
        }
        body.truncate(content_length);

        Some(RecordedRequest {
            method,
            path,
            headers,
            body: String::from_utf8_lossy(&body).to_string(),
        })
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// A KV v2 read body whose field map is `{foo: bar}` plus any extra fields rendered in.
    fn kv_body(fields: &[(&str, &str)]) -> String {
        let inner = fields
            .iter()
            .map(|(key, value)| format!("\"{key}\":\"{value}\""))
            .collect::<Vec<_>>()
            .join(",");
        format!("{{\"data\":{{\"data\":{{{inner}}}}}}}")
    }

    fn token_config(addr: &str) -> VaultConfig {
        VaultConfig {
            addr: addr.to_string(),
            auth: VaultAuth::Token("s.test-token".to_string()),
            mount: "secret".to_string(),
            path: "app".to_string(),
            namespace: None,
            cacert: None,
            cache_ttl: Duration::from_secs(60),
        }
    }

    #[test]
    fn token_auth_reads_fields_and_sends_the_token_header() {
        let server = MockVault::start(Arc::new(|_request: &RecordedRequest| {
            MockResponse::ok(&kv_body(&[("api_key", "secret-value"), ("other", "x")]))
        }));
        let provider = OpenBaoSecretProvider::new(token_config(&server.addr))
            .expect("construct with token auth");

        // A known secret round-trips, and an absent field is None.
        assert_eq!(provider.get("api_key").as_deref(), Some("secret-value"));
        assert_eq!(provider.get("other").as_deref(), Some("x"));
        assert_eq!(provider.get("missing"), None);

        let requests = server.requests();
        assert_eq!(requests.len(), 1, "construction performs exactly one read");
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].path, "/v1/secret/data/app");
        assert_eq!(
            requests[0].headers.get("x-vault-token").map(String::as_str),
            Some("s.test-token"),
        );
    }

    #[test]
    fn two_gets_serve_from_cache_with_a_single_upstream_read() {
        let server = MockVault::start(Arc::new(|_request: &RecordedRequest| {
            MockResponse::ok(&kv_body(&[("k", "v")]))
        }));
        let provider = OpenBaoSecretProvider::new(token_config(&server.addr)).expect("construct");

        assert_eq!(provider.get("k").as_deref(), Some("v"));
        assert_eq!(provider.get("k").as_deref(), Some("v"));

        assert_eq!(
            server.requests().len(),
            1,
            "get() must serve from cache and perform no I/O",
        );
    }

    #[test]
    fn ttl_expiry_refetches_and_updates_the_cache() {
        // The served value flips after the first read so a refetch is observable.
        let reads = Arc::new(AtomicUsize::new(0));
        let handler_reads = Arc::clone(&reads);
        let server = MockVault::start(Arc::new(move |_request: &RecordedRequest| {
            let count = handler_reads.fetch_add(1, Ordering::SeqCst);
            let value = if count == 0 { "first" } else { "second" };
            MockResponse::ok(&kv_body(&[("rotating", value)]))
        }));

        let mut config = token_config(&server.addr);
        config.cache_ttl = Duration::from_millis(150);
        let provider = OpenBaoSecretProvider::new(config).expect("construct");
        assert_eq!(provider.get("rotating").as_deref(), Some("first"));

        // Wait past a couple of TTL windows for the background refresh to land.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while provider.get("rotating").as_deref() != Some("second") {
            assert!(
                std::time::Instant::now() < deadline,
                "background refresh did not update the cache within the deadline",
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            reads.load(Ordering::SeqCst) >= 2,
            "a refresh must have performed a second upstream read",
        );
    }

    #[test]
    fn missing_secret_404_yields_all_absent_not_an_error() {
        let server = MockVault::start(Arc::new(|_request: &RecordedRequest| MockResponse {
            status: 404,
            body: "{\"errors\":[]}".to_string(),
        }));
        let provider = OpenBaoSecretProvider::new(token_config(&server.addr))
            .expect("a 404 at the path is an empty map, not a construction error");
        assert_eq!(provider.get("anything"), None);
    }

    #[test]
    fn kubernetes_login_then_read_sends_role_and_jwt_and_uses_the_issued_token() {
        // The service-account JWT comes from a temp file, as in production.
        let jwt_path =
            std::env::temp_dir().join(format!("keel-vault-jwt-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&jwt_path, "sa-jwt-token-contents\n").expect("write jwt file");

        let server = MockVault::start(Arc::new(|request: &RecordedRequest| {
            if request.method == "POST" {
                // Login: echo a client token the subsequent read must present.
                MockResponse::ok("{\"auth\":{\"client_token\":\"issued.k8s.token\"}}")
            } else {
                MockResponse::ok(&kv_body(&[("db_password", "hunter2")]))
            }
        }));

        let config = VaultConfig {
            addr: server.addr.clone(),
            auth: VaultAuth::Kubernetes {
                role: "keel-role".to_string(),
                mount: DEFAULT_K8S_MOUNT.to_string(),
                jwt_path: jwt_path.to_string_lossy().to_string(),
            },
            mount: "secret".to_string(),
            path: "app".to_string(),
            namespace: None,
            cacert: None,
            cache_ttl: Duration::from_secs(60),
        };
        let provider = OpenBaoSecretProvider::new(config).expect("construct with k8s auth");
        assert_eq!(provider.get("db_password").as_deref(), Some("hunter2"));

        let requests = server.requests();
        let login = &requests[0];
        assert_eq!(login.method, "POST");
        assert_eq!(login.path, "/v1/auth/kubernetes/login");
        let login_body: serde_json::Value =
            serde_json::from_str(&login.body).expect("login body is JSON");
        assert_eq!(login_body["role"], "keel-role");
        assert_eq!(
            login_body["jwt"], "sa-jwt-token-contents",
            "the JWT file contents (trimmed) must be posted as the login jwt",
        );

        let read = &requests[1];
        assert_eq!(read.method, "GET");
        assert_eq!(
            read.headers.get("x-vault-token").map(String::as_str),
            Some("issued.k8s.token"),
            "the read must present the token issued by the login",
        );

        let _ = std::fs::remove_file(&jwt_path);
    }

    #[test]
    fn forbidden_read_triggers_reauth_and_a_single_retry() {
        let jwt_path =
            std::env::temp_dir().join(format!("keel-vault-jwt-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&jwt_path, "sa-jwt").expect("write jwt file");

        let logins = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let handler_logins = Arc::clone(&logins);
        let handler_reads = Arc::clone(&reads);
        let server = MockVault::start(Arc::new(move |request: &RecordedRequest| {
            if request.method == "POST" {
                let n = handler_logins.fetch_add(1, Ordering::SeqCst);
                MockResponse::ok(&format!("{{\"auth\":{{\"client_token\":\"token-{n}\"}}}}"))
            } else {
                let n = handler_reads.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    // First read is forbidden: the client must re-login and retry once.
                    MockResponse {
                        status: 403,
                        body: "{\"errors\":[\"permission denied\"]}".to_string(),
                    }
                } else {
                    MockResponse::ok(&kv_body(&[("token", "value")]))
                }
            }
        }));

        let config = VaultConfig {
            addr: server.addr.clone(),
            auth: VaultAuth::Kubernetes {
                role: "r".to_string(),
                mount: DEFAULT_K8S_MOUNT.to_string(),
                jwt_path: jwt_path.to_string_lossy().to_string(),
            },
            mount: "secret".to_string(),
            path: "app".to_string(),
            namespace: None,
            cacert: None,
            cache_ttl: Duration::from_secs(60),
        };
        let provider = OpenBaoSecretProvider::new(config).expect("construct");
        assert_eq!(provider.get("token").as_deref(), Some("value"));
        assert_eq!(
            logins.load(Ordering::SeqCst),
            2,
            "a 403 on read must trigger exactly one re-login (initial + re-auth)",
        );
        assert_eq!(
            reads.load(Ordering::SeqCst),
            2,
            "the read is retried exactly once after re-auth",
        );

        let _ = std::fs::remove_file(&jwt_path);
    }

    #[test]
    fn namespace_header_is_sent_when_configured() {
        let server = MockVault::start(Arc::new(|_request: &RecordedRequest| {
            MockResponse::ok(&kv_body(&[("k", "v")]))
        }));
        let mut config = token_config(&server.addr);
        config.namespace = Some("team-a".to_string());
        let provider = OpenBaoSecretProvider::new(config).expect("construct");
        assert_eq!(provider.get("k").as_deref(), Some("v"));

        let requests = server.requests();
        assert_eq!(
            requests[0]
                .headers
                .get("x-vault-namespace")
                .map(String::as_str),
            Some("team-a"),
        );
    }

    #[test]
    fn construction_fails_closed_when_the_server_is_unreachable() {
        // Bind then drop a listener to get a port nothing is listening on.
        let addr = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        // Discard a surprise Ok(provider) (not Debug) so only the error is formatted on failure.
        let error = OpenBaoSecretProvider::new(token_config(&addr)).err();
        assert!(
            matches!(error, Some(VaultError::Read(_))),
            "an unreachable server must fail construction, never fall back to the env: {error:?}",
        );
    }

    #[test]
    fn from_env_fails_closed_without_auth() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved = EnvSnapshot::take(&[
            "KEEL_VAULT_ADDR",
            "KEEL_VAULT_PATH",
            "KEEL_VAULT_TOKEN",
            "KEEL_VAULT_ROLE",
        ]);
        std::env::set_var("KEEL_VAULT_ADDR", "https://openbao:8200");
        std::env::set_var("KEEL_VAULT_PATH", "app");
        std::env::remove_var("KEEL_VAULT_TOKEN");
        std::env::remove_var("KEEL_VAULT_ROLE");

        let result = VaultConfig::from_env();
        assert!(
            matches!(result, Err(VaultError::Config(_))),
            "addr set with no auth must be a fail-closed config error: {result:?}",
        );

        saved.restore();
    }

    #[test]
    fn from_env_parses_token_auth_and_defaults() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved = EnvSnapshot::take(&[
            "KEEL_VAULT_ADDR",
            "KEEL_VAULT_PATH",
            "KEEL_VAULT_TOKEN",
            "KEEL_VAULT_ROLE",
            "KEEL_VAULT_MOUNT",
            "KEEL_VAULT_NAMESPACE",
        ]);
        std::env::set_var("KEEL_VAULT_ADDR", "https://openbao:8200/");
        std::env::set_var("KEEL_VAULT_PATH", "keel-test");
        std::env::set_var("KEEL_VAULT_TOKEN", "root");
        std::env::remove_var("KEEL_VAULT_ROLE");
        std::env::remove_var("KEEL_VAULT_MOUNT");
        std::env::remove_var("KEEL_VAULT_NAMESPACE");

        let config = VaultConfig::from_env().expect("valid token config");
        assert_eq!(
            config.addr, "https://openbao:8200",
            "trailing slash trimmed"
        );
        assert_eq!(config.mount, "secret", "default KV mount");
        assert_eq!(config.cache_ttl, DEFAULT_CACHE_TTL);
        assert!(matches!(config.auth, VaultAuth::Token(ref t) if t == "root"));

        saved.restore();
    }

    #[test]
    fn cache_ttl_non_positive_or_unparseable_fails_construction() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved = EnvSnapshot::take(&[
            "KEEL_VAULT_ADDR",
            "KEEL_VAULT_PATH",
            "KEEL_VAULT_TOKEN",
            "KEEL_VAULT_ROLE",
            "KEEL_VAULT_CACHE_TTL_SECONDS",
        ]);
        std::env::set_var("KEEL_VAULT_ADDR", "https://openbao:8200");
        std::env::set_var("KEEL_VAULT_PATH", "app");
        std::env::set_var("KEEL_VAULT_TOKEN", "root");
        std::env::remove_var("KEEL_VAULT_ROLE");

        // A zero, negative, fractional, or non-numeric TTL must fail construction (ADR-0023):
        // it is a misconfiguration, not a value to clamp to 1s.
        for bad in ["0", "-5", "abc", "1.5"] {
            std::env::set_var("KEEL_VAULT_CACHE_TTL_SECONDS", bad);
            let result = VaultConfig::from_env();
            assert!(
                matches!(result, Err(VaultError::Config(_))),
                "TTL {bad:?} must fail construction rather than clamp: {result:?}",
            );
        }

        // A valid positive TTL is honored verbatim.
        std::env::set_var("KEEL_VAULT_CACHE_TTL_SECONDS", "5");
        let config = VaultConfig::from_env().expect("a positive TTL is valid");
        assert_eq!(config.cache_ttl, Duration::from_secs(5));

        saved.restore();
    }

    #[test]
    fn field_coercion_scalars_to_canonical_strings_and_non_scalars_absent() {
        // ADR-0023 coercion: scalars become their canonical string; object/array/null have no
        // flat-key representation and are dropped (absent), never serialized to JSON text.
        let raw = r#"{
            "str": "plain",
            "int": 42,
            "float": 3.5,
            "bool_true": true,
            "bool_false": false,
            "obj": {"nested": "x"},
            "arr": [1, 2, 3],
            "nothing": null
        }"#;
        let map: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(raw).expect("parse the test field map");
        let fields = flatten_fields(map);

        assert_eq!(fields.get("str").map(String::as_str), Some("plain"));
        assert_eq!(fields.get("int").map(String::as_str), Some("42"));
        assert_eq!(fields.get("float").map(String::as_str), Some("3.5"));
        assert_eq!(fields.get("bool_true").map(String::as_str), Some("true"));
        assert_eq!(fields.get("bool_false").map(String::as_str), Some("false"));
        // Non-scalars are absent, not serialized JSON a caller would mistake for the value.
        assert_eq!(fields.get("obj"), None);
        assert_eq!(fields.get("arr"), None);
        assert_eq!(fields.get("nothing"), None);
    }

    #[test]
    fn short_lease_triggers_proactive_relogin_before_the_cache_ttl() {
        // A Kubernetes login that issues a 1s lease, with a long (60s) cache TTL: the refresh
        // thread must proactively re-login (lease renewal) well before the cache would refresh,
        // and that renewal must not perform a field-map read.
        let jwt_path =
            std::env::temp_dir().join(format!("keel-vault-jwt-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&jwt_path, "sa-jwt").expect("write jwt file");

        let logins = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let handler_logins = Arc::clone(&logins);
        let handler_reads = Arc::clone(&reads);
        let server = MockVault::start(Arc::new(move |request: &RecordedRequest| {
            if request.method == "POST" {
                let n = handler_logins.fetch_add(1, Ordering::SeqCst);
                MockResponse::ok(&format!(
                    "{{\"auth\":{{\"client_token\":\"token-{n}\",\"lease_duration\":1}}}}"
                ))
            } else {
                handler_reads.fetch_add(1, Ordering::SeqCst);
                MockResponse::ok(&kv_body(&[("k", "v")]))
            }
        }));

        let config = VaultConfig {
            addr: server.addr.clone(),
            auth: VaultAuth::Kubernetes {
                role: "r".to_string(),
                mount: DEFAULT_K8S_MOUNT.to_string(),
                jwt_path: jwt_path.to_string_lossy().to_string(),
            },
            mount: "secret".to_string(),
            path: "app".to_string(),
            namespace: None,
            cacert: None,
            cache_ttl: Duration::from_secs(60),
        };
        let provider = OpenBaoSecretProvider::new(config).expect("construct with k8s auth");
        assert_eq!(provider.get("k").as_deref(), Some("v"));

        // A second login (the proactive renewal) must arrive well before the 60s cache TTL.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while logins.load(Ordering::SeqCst) < 2 {
            assert!(
                std::time::Instant::now() < deadline,
                "a proactive re-login did not occur before the deadline (logins={})",
                logins.load(Ordering::SeqCst),
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "proactive renewal must re-login only, not read; the cache TTL has not elapsed",
        );

        let _ = std::fs::remove_file(&jwt_path);
    }

    #[test]
    fn refresh_failure_logs_neither_the_secret_nor_the_token() {
        const CANARY_SECRET: &str = "super-secret-leak-canary-value-9f3a";
        const CANARY_TOKEN: &str = "canary.token.value.7b2e";

        // The first read serves the canary secret (so construction succeeds and caches it);
        // every later read returns 500, so the next `load` fails exactly as a background refresh
        // would. The mock is driven on this thread so the failure log can be captured with a
        // thread-local subscriber (the process-global slot is already claimed by another test).
        let reads = Arc::new(AtomicUsize::new(0));
        let handler_reads = Arc::clone(&reads);
        let server = MockVault::start(Arc::new(move |_request: &RecordedRequest| {
            let n = handler_reads.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                MockResponse::ok(&kv_body(&[("api_key", CANARY_SECRET)]))
            } else {
                MockResponse {
                    status: 500,
                    body: "{\"errors\":[\"boom\"]}".to_string(),
                }
            }
        }));

        // A very long cache TTL so the background thread does not race us to the second read:
        // we drive the failing refresh ourselves to get its real error.
        let mut config = token_config(&server.addr);
        config.auth = VaultAuth::Token(CANARY_TOKEN.to_string());
        config.cache_ttl = Duration::from_secs(3600);
        let provider = OpenBaoSecretProvider::new(config.clone()).expect("construct");
        assert_eq!(provider.get("api_key").as_deref(), Some(CANARY_SECRET));

        // Reproduce a background refresh failure: a real `load` against the now-500 endpoint,
        // carrying the real token, yields the real error the refresh loop would log.
        let client = build_client(None).expect("build client");
        let token_state = Mutex::new(CANARY_TOKEN.to_string());
        let error = load(&client, &config, &token_state).expect_err("the 500 must fail the load");

        // Capture exactly the refresh-failure log event (the shared `log_refresh_failure` the
        // background loop calls) via a thread-local subscriber.
        let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(LogBufferWriter(Arc::clone(&buffer)))
            .with_max_level(tracing::Level::DEBUG)
            .finish();
        tracing::subscriber::with_default(subscriber, || log_refresh_failure(&error));

        let text =
            String::from_utf8(buffer.lock().expect("log buffer lock").clone()).expect("utf8 logs");
        assert!(
            text.contains("openbao background refresh failed"),
            "the refresh-failure path must have logged (capture sanity): {text:?}",
        );
        assert!(
            !text.contains(CANARY_SECRET),
            "the cached secret value must never appear in any log line: {text:?}",
        );
        assert!(
            !text.contains(CANARY_TOKEN),
            "the client token must never appear in any log line: {text:?}",
        );
    }

    /// A `MakeWriter` capturing every emitted log line into a shared buffer, so a test can read
    /// back exactly what was logged.
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

    // Env-mutating tests share the process environment, so serialize them.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Saves and restores a set of env vars around a test that mutates them.
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
}
