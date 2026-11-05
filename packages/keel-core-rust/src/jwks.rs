//! JWKS-over-HTTPS signing-key resolver for the OIDC authenticator.
//!
//! Fetches the issuer's JSON Web Key Set, caches the keys by `kid`, and exposes a
//! sync [`KeyResolver`] (a cache read, no blocking I/O on the request path). Refresh
//! the cache at startup and periodically; a `kid` that is not cached resolves to
//! `NotFound` (401), a lock problem to `Unavailable` (503). The `jwks_uri` must be
//! https unless `allow_insecure` is set (local dev only).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::DecodingKey;

use crate::auth::{KeyLookupError, KeyResolver};
use crate::domain::errors::{DomainError, ErrorCategory};

type KeyMap = Arc<RwLock<HashMap<String, DecodingKey>>>;

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
        Ok(Self {
            jwks_uri: jwks_uri.to_string(),
            client: reqwest::Client::new(),
            keys: Arc::new(RwLock::new(HashMap::new())),
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
}
