//! JWKS-over-HTTPS signing-key resolver for the OIDC authenticator.
//!
//! Fetches the issuer's JSON Web Key Set, caches the keys by `kid`, and exposes a
//! sync [`KeyResolver`] (a cache read, no blocking I/O on the request path). Refresh
//! the cache at startup, then periodically via [`JwksCache::spawn_background_refresh`]
//! so the service tolerates IdP signing-key rotation without a restart; a `kid` that
//! is not cached resolves to `NotFound` (401), a lock problem to `Unavailable` (503).
//! The HTTP fetch is bounded by connect and request timeouts so a stalled endpoint
//! cannot hang a refresh forever. The `jwks_uri` must be https unless `allow_insecure`
//! is set (local dev only).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::DecodingKey;

use crate::auth::{KeyLookupError, KeyResolver};
use crate::domain::errors::{DomainError, ErrorCategory};

type KeyMap = Arc<RwLock<HashMap<String, DecodingKey>>>;

/// Request timeout for a single JWKS fetch (total, including body read).
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Connect timeout for the JWKS fetch (bounds a black-holed endpoint at the TCP layer).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// A cache of JWKS signing keys, refreshable from the issuer's JWKS endpoint.
pub struct JwksCache {
    jwks_uri: String,
    client: reqwest::Client,
    keys: KeyMap,
}

impl JwksCache {
    /// Build a cache for `jwks_uri` (must be https unless `allow_insecure`).
    ///
    /// # Errors
    /// Returns an `Internal` [`DomainError`] if `jwks_uri` is not https and
    /// `allow_insecure` is false.
    pub fn new(jwks_uri: &str, allow_insecure: bool) -> Result<Self, DomainError> {
        if !allow_insecure && !jwks_uri.to_lowercase().starts_with("https://") {
            return Err(DomainError::new(
                ErrorCategory::Internal,
                "jwks_uri must use https (set allow_insecure for local dev only)",
            ));
        }
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|error| {
                DomainError::new(
                    ErrorCategory::Internal,
                    format!("jwks http client build: {error}"),
                )
            })?;
        Ok(Self {
            jwks_uri: jwks_uri.to_string(),
            client,
            keys: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Spawn a background task that refreshes the cache every `interval`, so the service
    /// tolerates IdP signing-key rotation without a restart. A transient refresh failure
    /// is logged (not fatal); the previously cached keys keep serving until the next
    /// success. Returns the task handle so the caller can abort it on shutdown.
    ///
    /// Call once, after the initial [`JwksCache::refresh`], from an async (tokio) context.
    /// The returned [`KeyResolver`] from [`JwksCache::resolver`] shares the same key map,
    /// so refreshes performed by this task are visible to resolvers already handed out.
    #[must_use]
    pub fn spawn_background_refresh(
        self: Arc<Self>,
        interval: Duration,
    ) -> tokio::task::JoinHandle<()> {
        // tokio::time::interval panics on a zero period; clamp so a misconfigured
        // interval (e.g. 0) cannot silently kill the refresher instead of refreshing.
        let interval = interval.max(Duration::from_secs(1));
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            // The first tick fires immediately; skip it since the caller already did the
            // initial refresh. Subsequent ticks are the periodic refreshes.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if let Err(error) = self.refresh().await {
                    tracing::warn!(error = %error, "jwks background refresh failed; serving cached keys");
                }
            }
        })
    }

    /// Fetch the JWKS and replace the cached keys.
    ///
    /// # Errors
    /// Returns an `Unavailable` [`DomainError`] if the endpoint cannot be fetched or parsed.
    pub async fn refresh(&self) -> Result<(), DomainError> {
        let unavailable = |context: &str, error: &dyn std::fmt::Display| {
            DomainError::new(
                ErrorCategory::Unavailable,
                format!("jwks {context}: {error}"),
            )
        };
        let set: JwkSet = self
            .client
            .get(&self.jwks_uri)
            .send()
            .await
            .map_err(|error| unavailable("fetch", &error))?
            .error_for_status()
            .map_err(|error| unavailable("status", &error))?
            .json()
            .await
            .map_err(|error| unavailable("parse", &error))?;

        let mut next = HashMap::new();
        for jwk in &set.keys {
            if let (Some(kid), Ok(key)) = (jwk.common.key_id.clone(), DecodingKey::from_jwk(jwk)) {
                next.insert(kid, key);
            }
        }
        // A 200 response with no usable keys must not wipe the cache: that would turn a
        // transient IdP glitch into a full auth outage. Return an error instead, so the
        // background task logs and keeps serving the previously cached keys (and startup,
        // which propagates this error, fails loudly rather than booting keyless).
        if next.is_empty() {
            return Err(DomainError::new(
                ErrorCategory::Unavailable,
                "jwks response contained no usable keys",
            ));
        }
        *self.keys.write().map_err(|_| {
            DomainError::new(ErrorCategory::Unavailable, "jwks cache lock poisoned")
        })? = next;
        Ok(())
    }

    /// A sync resolver over the cached keys, for the OIDC authenticator.
    pub fn resolver(&self) -> KeyResolver {
        let keys = Arc::clone(&self.keys);
        Box::new(move |kid: Option<&str>| {
            let kid = kid.ok_or(KeyLookupError::NotFound)?;
            let guard = keys
                .read()
                .map_err(|_| KeyLookupError::Unavailable("jwks cache lock poisoned".to_string()))?;
            guard.get(kid).cloned().ok_or(KeyLookupError::NotFound)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::JwksCache;
    use crate::auth::KeyLookupError;
    use jsonwebtoken::DecodingKey;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn a_zero_refresh_interval_is_clamped_and_does_not_panic_the_task() {
        // A zero interval would panic tokio::time::interval inside the spawned task and
        // silently kill the refresher; the clamp keeps it alive.
        let cache = Arc::new(JwksCache::new("https://idp.example/jwks", false).unwrap());
        let handle = Arc::clone(&cache).spawn_background_refresh(Duration::ZERO);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !handle.is_finished(),
            "the refresher must survive a zero interval (clamped to >= 1s), not panic"
        );
        handle.abort();
    }

    #[test]
    fn requires_https_unless_allow_insecure() {
        assert!(JwksCache::new("http://idp.example/jwks", false).is_err());
        assert!(JwksCache::new("http://idp.example/jwks", true).is_ok());
        assert!(JwksCache::new("https://idp.example/jwks", false).is_ok());
    }

    #[test]
    fn resolver_hits_cached_kid_and_misses_others() {
        let cache = JwksCache::new("https://idp.example/jwks", false).unwrap();
        cache
            .keys
            .write()
            .unwrap()
            .insert("kid-1".to_string(), DecodingKey::from_secret(b"test"));
        let resolver = cache.resolver();
        assert!(resolver(Some("kid-1")).is_ok());
        assert!(matches!(
            resolver(Some("absent")),
            Err(KeyLookupError::NotFound)
        ));
        assert!(matches!(resolver(None), Err(KeyLookupError::NotFound)));
    }

    #[test]
    fn a_refresh_is_visible_to_a_resolver_handed_out_earlier() {
        // This is the property that makes background refresh tolerate key rotation:
        // a resolver captures the shared key map, so keys written by a later refresh
        // (here simulated by a direct insert) resolve without re-creating the resolver.
        use std::sync::Arc;
        let cache = Arc::new(JwksCache::new("https://idp.example/jwks", false).unwrap());
        let resolver = cache.resolver();
        assert!(matches!(
            resolver(Some("rotated-kid")),
            Err(KeyLookupError::NotFound)
        ));
        cache
            .keys
            .write()
            .unwrap()
            .insert("rotated-kid".to_string(), DecodingKey::from_secret(b"new"));
        assert!(resolver(Some("rotated-kid")).is_ok());
    }
}
