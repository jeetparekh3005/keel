//! Shared caching core for the production `SecretProvider` backends (ADR-0024 decision 3).
//!
//! ADR-0023 shipped the OpenBao backend with a specific model: authenticate, load a field map
//! into an in-memory cache, serve [`SecretProvider::get`] synchronously from that cache with no
//! I/O, refresh every TTL on a dedicated `std::thread`, serve the last good map on a failed
//! refresh, and never log a token or secret value. ADR-0024 adds AWS Secrets Manager (and later
//! GCP) behind the same port with identical semantics, so this module factors that model into
//! one engine parameterized by a [`SecretLoader`]: the loader authenticates and returns the raw
//! field map, the core owns caching, refresh scheduling, fail-closed construction, and the
//! no-leak serving path. OpenBao, AWS, and GCP are three loaders over one core, not three copies.
//!
//! The loader is the only backend-specific part. OpenBao's loader additionally carries Vault
//! lease re-login via [`SecretLoader::next_maintenance`]/[`SecretLoader::maintain`]; AWS/GCP
//! loaders leave those at their defaults because the SDK refreshes credentials internally and the
//! core simply re-invokes the loader every TTL.
//!
//! This module compiles only when a production backend feature is on (`vault`, `aws`, or `gcp`);
//! the default core build stays env-only.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::adapters::EnvSecretProvider;
use crate::ports::SecretProvider;

/// Default field-map cache TTL when `KEEL_SECRET_CACHE_TTL_SECONDS` is unset (ADR-0024).
pub(crate) const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(60);

/// Read an environment variable, treating empty or whitespace-only as unset and trimming
/// surrounding whitespace (ADR-0023 "whitespace addr = unset", applied to every gating var).
pub(crate) fn env_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Resolve the shared cache TTL from `KEEL_SECRET_CACHE_TTL_SECONDS` (ADR-0024): it must parse to
/// a positive integer, else construction fails closed (a non-positive or unparseable value is a
/// misconfiguration, not a value to clamp - silently serving a 1s cache would hammer the backend
/// and hide the typo). Unset yields [`DEFAULT_CACHE_TTL`]. Returns the error message so each
/// backend can wrap it in its own config-error variant.
pub(crate) fn parse_cache_ttl() -> Result<Duration, String> {
    match env_var("KEEL_SECRET_CACHE_TTL_SECONDS") {
        Some(raw) => {
            let seconds: u64 =
                raw.parse()
                    .ok()
                    .filter(|seconds| *seconds > 0)
                    .ok_or_else(|| {
                        format!(
                            "KEEL_SECRET_CACHE_TTL_SECONDS must be a positive integer, got {raw:?}"
                        )
                    })?;
            Ok(Duration::from_secs(seconds))
        }
        None => Ok(DEFAULT_CACHE_TTL),
    }
}

/// Coerce a JSON field map to flat string fields (ADR-0023 field coercion, shared by all
/// backends): a scalar becomes its canonical string (a string passes through, a number becomes
/// its JSON text, a boolean becomes `"true"`/`"false"`); a non-scalar (object, array, or null)
/// has no canonical flat-key representation and is dropped, so `get()` reports it absent rather
/// than returning serialized JSON a caller would mistake for the secret value.
pub(crate) fn flatten_fields(
    data: serde_json::Map<String, serde_json::Value>,
) -> HashMap<String, String> {
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

/// A backend loader: authenticates and returns the raw field map. Everything that differs per
/// backend (OpenBao's KV v2 read plus lease re-login, AWS's `GetSecretValue`) lives behind this
/// trait; the caching, refresh scheduling, fail-closed construction, and no-leak serving live in
/// [`CachingSecretProvider`]. The loader runs only on the dedicated refresh thread, so it need
/// not be `Sync` and may hold single-threaded state (e.g. a current-thread tokio runtime).
pub(crate) trait SecretLoader: Send {
    /// The backend's error type. Its `Display` MUST NOT include any token, credential, or secret
    /// value (no-leak invariant), because it reaches the logs via [`log_load_failure`](Self::log_load_failure).
    type Error: std::fmt::Display + Send + 'static;

    /// Load the current field map. Called once eagerly at construction (its error fails
    /// construction closed, with no fall-through to the environment) and again every TTL (its
    /// error is logged and the last good map keeps serving).
    fn load(&mut self) -> Result<HashMap<String, String>, Self::Error>;

    /// An optional proactive-maintenance deadline (e.g. OpenBao lease re-login). The core wakes
    /// at the nearer of this and the next TTL refresh and calls [`maintain`](Self::maintain).
    /// The default `None` fits AWS/GCP, whose SDKs refresh credentials internally.
    fn next_maintenance(&self) -> Option<Instant> {
        None
    }

    /// Perform proactive maintenance (default: nothing). Called when the core reaches the
    /// [`next_maintenance`](Self::next_maintenance) deadline.
    fn maintain(&mut self) {}

    /// Log a failed background refresh. The backend owns the message so it can name itself, and
    /// MUST pass only the error (never a token, credential, or secret value) to the logger.
    fn log_load_failure(&self, error: &Self::Error);
}

/// Why starting the cache failed: a loader error on the eager first load (propagated as the
/// backend's own error, fail-closed), or an internal error setting up the refresh thread.
pub(crate) enum StartError<E> {
    /// The eager initial load failed; carries the backend's loader error verbatim.
    Load(E),
    /// Spawning or communicating with the refresh thread failed (should not happen in practice).
    Internal(String),
}

/// A [`SecretProvider`] that serves `get()` synchronously from an in-memory field-map cache,
/// which a dedicated background thread refreshes every TTL by invoking a [`SecretLoader`]
/// (ADR-0024 shared caching core). Construction performs the eager first load and fails closed
/// if it fails; [`Drop`] stops and joins the thread.
pub(crate) struct CachingSecretProvider {
    /// The cached field map; the only thing `get()` touches (a pure, I/O-free read).
    cache: Arc<RwLock<HashMap<String, String>>>,
    /// Stop flag + condvar used to wake and end the refresh thread promptly on drop.
    stop: Arc<(Mutex<bool>, Condvar)>,
    /// The refresh thread handle, joined on drop.
    handle: Option<JoinHandle<()>>,
}

impl CachingSecretProvider {
    /// Start the cache: spawn the refresh thread, run the eager first load on it, and block until
    /// that load reports success or failure. All backend I/O runs on the refresh thread (never on
    /// the caller's thread), so this is safe to call from within an async runtime even though it
    /// blocks until the first load completes.
    ///
    /// # Errors
    /// Returns [`StartError::Load`] if the eager first load fails (fail-closed), or
    /// [`StartError::Internal`] if the refresh thread cannot be spawned or is lost.
    pub(crate) fn start<L: SecretLoader + 'static>(
        loader: L,
        cache_ttl: Duration,
        thread_name: &'static str,
    ) -> Result<Self, StartError<L::Error>> {
        let cache: Arc<RwLock<HashMap<String, String>>> = Arc::new(RwLock::new(HashMap::new()));
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        // One-shot channel the refresh thread uses to report the eager load's result, so
        // construction fails closed when the first authenticate/load fails.
        let (init_tx, init_rx) = mpsc::channel::<Result<(), L::Error>>();

        let thread_cache = Arc::clone(&cache);
        let thread_stop = Arc::clone(&stop);
        let handle = std::thread::Builder::new()
            .name(thread_name.to_string())
            .spawn(move || refresh_loop(loader, cache_ttl, thread_cache, thread_stop, init_tx))
            .map_err(|error| {
                StartError::Internal(format!("spawn {thread_name} thread: {error}"))
            })?;

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                cache,
                stop,
                handle: Some(handle),
            }),
            Ok(Err(error)) => {
                // The thread finished after reporting the failure; join it so no thread leaks.
                let _ = handle.join();
                Err(StartError::Load(error))
            }
            Err(_) => {
                let _ = handle.join();
                Err(StartError::Internal(
                    "refresh thread terminated before reporting the initial load".into(),
                ))
            }
        }
    }

    /// Serve a secret from the cache: a pure read with no I/O. A poisoned lock (a writer panicked)
    /// reports absent rather than propagating the panic through the port.
    pub(crate) fn get(&self, key: &str) -> Option<String> {
        self.cache
            .read()
            .ok()
            .and_then(|fields| fields.get(key).cloned())
    }
}

impl Drop for CachingSecretProvider {
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

/// The refresh thread body: run the eager initial load (reporting its result back to
/// construction), then re-load every `cache_ttl` and run any proactive maintenance the loader
/// schedules, until stopped. A failed refresh keeps serving the last good map and is logged, so a
/// transient backend outage does not take the service down.
fn refresh_loop<L: SecretLoader>(
    mut loader: L,
    cache_ttl: Duration,
    cache: Arc<RwLock<HashMap<String, String>>>,
    stop: Arc<(Mutex<bool>, Condvar)>,
    init_tx: mpsc::Sender<Result<(), L::Error>>,
) {
    match loader.load() {
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

    // Periodic work: refresh the field map every `cache_ttl` and, independently, run the loader's
    // proactive maintenance (e.g. a Vault lease re-login) when it schedules one. The thread sleeps
    // until the nearer of the two deadlines (or the stop signal).
    let (lock, cvar) = &*stop;
    let mut next_refresh = Instant::now() + cache_ttl;
    loop {
        let now = Instant::now();
        let wake_at = match loader.next_maintenance() {
            Some(maintenance) => next_refresh.min(maintenance),
            None => next_refresh,
        };
        let wait = wake_at.saturating_duration_since(now);
        let stopping = {
            let Ok(guard) = lock.lock() else { break };
            // Check the stop flag BEFORE waiting. `Drop` sets it under this same lock and then
            // notifies; a notify that lands between the previous iteration releasing the lock and
            // this `wait_timeout` would otherwise be lost, and the thread would sleep the full
            // `wait` (up to the TTL) before noticing the shutdown - a lost-wakeup that stalls the
            // Drop-time join for a whole TTL. Testing the flag while holding the lock closes that
            // window: either we observe the stop here, or we are already parked in `wait_timeout`
            // when Drop takes the lock and are woken by its notify.
            if *guard {
                true
            } else {
                let (guard, _timeout) = match cvar.wait_timeout(guard, wait) {
                    Ok(result) => result,
                    Err(_) => break,
                };
                *guard
            }
        };
        if stopping {
            break;
        }

        let now = Instant::now();
        if let Some(maintenance) = loader.next_maintenance() {
            if now >= maintenance {
                loader.maintain();
            }
        }
        if now >= next_refresh {
            match loader.load() {
                Ok(fields) => {
                    if let Ok(mut writable) = cache.write() {
                        *writable = fields;
                    }
                }
                Err(error) => {
                    // A transient outage must not take the service down: keep the last good map.
                    loader.log_load_failure(&error);
                }
            }
            next_refresh = Instant::now() + cache_ttl;
        }
    }
}

/// Failure selecting or constructing the production secret provider (ADR-0024 fail-closed
/// selection). Construction failures fail loudly rather than falling through to the environment.
#[derive(Debug, thiserror::Error)]
pub enum SecretProviderError {
    /// More than one backend gating variable is set - an ambiguous misconfiguration.
    #[error(
        "multiple secret backends configured: set at most one of KEEL_VAULT_ADDR, KEEL_AWS_SECRET_ID, KEEL_GCP_SECRET"
    )]
    MultipleBackends,
    /// A backend's gating variable is set but that backend's cargo feature is not compiled into
    /// this build. Surfaced (not silently ignored) so configuration never falls through to the
    /// environment when a production backend was asked for. Never constructed in an all-features
    /// build, where every backend is present.
    #[allow(dead_code)]
    #[error("secret backend {0} is configured but its cargo feature is not enabled in this build")]
    BackendNotCompiled(&'static str),
    /// The OpenBao backend failed to construct (bad config, auth failure, unreachable server).
    #[cfg(feature = "vault")]
    #[error(transparent)]
    Vault(#[from] crate::vault::VaultError),
    /// The AWS Secrets Manager backend failed to construct (bad config, auth failure, unreadable
    /// or malformed secret).
    #[cfg(feature = "aws")]
    #[error(transparent)]
    Aws(#[from] crate::aws::AwsError),
    /// The GCP Secret Manager backend failed to construct (bad config, auth failure, unreadable
    /// or malformed secret).
    #[cfg(feature = "gcp")]
    #[error(transparent)]
    Gcp(#[from] crate::gcp::GcpError),
}

/// Select the production secret provider fail-closed (ADR-0024): at most one of `KEEL_VAULT_ADDR`
/// (OpenBao), `KEEL_AWS_SECRET_ID` (AWS Secrets Manager), or `KEEL_GCP_SECRET` (GCP Secret Manager)
/// may be set; more than one is an ambiguous misconfiguration that fails. None set yields the dev
/// [`EnvSecretProvider`]. Boxed as `Arc<dyn SecretProvider>` for the service composition root.
///
/// # Errors
/// Returns [`SecretProviderError`] when more than one backend is configured, when a configured
/// backend's feature is not compiled in, or when the selected backend cannot be built (bad
/// config, auth failure, unreachable server): the service fails to start rather than silently
/// reading secrets from the environment.
pub fn secret_provider_from_env() -> Result<Arc<dyn SecretProvider>, SecretProviderError> {
    let vault_set = env_var("KEEL_VAULT_ADDR").is_some();
    let aws_set = env_var("KEEL_AWS_SECRET_ID").is_some();
    let gcp_set = env_var("KEEL_GCP_SECRET").is_some();

    if [vault_set, aws_set, gcp_set]
        .into_iter()
        .filter(|set| *set)
        .count()
        > 1
    {
        return Err(SecretProviderError::MultipleBackends);
    }

    if vault_set {
        #[cfg(feature = "vault")]
        {
            return Ok(Arc::new(crate::vault::OpenBaoSecretProvider::from_env()?));
        }
        #[cfg(not(feature = "vault"))]
        {
            return Err(SecretProviderError::BackendNotCompiled("KEEL_VAULT_ADDR"));
        }
    }

    if aws_set {
        #[cfg(feature = "aws")]
        {
            return Ok(Arc::new(
                crate::aws::AwsSecretsManagerSecretProvider::from_env()?,
            ));
        }
        #[cfg(not(feature = "aws"))]
        {
            return Err(SecretProviderError::BackendNotCompiled(
                "KEEL_AWS_SECRET_ID",
            ));
        }
    }

    if gcp_set {
        #[cfg(feature = "gcp")]
        {
            return Ok(Arc::new(
                crate::gcp::GcpSecretManagerSecretProvider::from_env()?,
            ));
        }
        #[cfg(not(feature = "gcp"))]
        {
            return Err(SecretProviderError::BackendNotCompiled("KEEL_GCP_SECRET"));
        }
    }

    Ok(Arc::new(EnvSecretProvider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flatten_coerces_scalars_and_drops_non_scalars() {
        // ADR-0023 coercion, shared by every backend: scalars become their canonical string;
        // object/array/null are dropped (absent), never serialized to JSON text.
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
        assert_eq!(fields.get("obj"), None);
        assert_eq!(fields.get("arr"), None);
        assert_eq!(fields.get("nothing"), None);
    }
}
