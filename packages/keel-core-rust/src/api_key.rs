//! API-key authenticator adapter (platform.yaml auth; ADR-0006).
//!
//! Verifies an opaque API key against a configured set of SHA-256 key hashes and maps
//! it to a [`Principal`]. Keys are stored **hashed** (never plaintext) so a memory
//! disclosure does not leak usable credentials; the presented key is hashed and looked
//! up. Keys/hashes should come from the [`crate::ports::SecretProvider`] (config/secret
//! store), never source. The Rust mirror of `keel_core.adapters.outbound.auth.api_key`.

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use crate::auth::{Authenticator, Principal};
use crate::domain::errors::{DomainError, ErrorCategory};

/// Return the SHA-256 hex digest used to store and look up an API key.
#[must_use]
pub fn hash_api_key(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    // Lowercase hex, matching Python's `hashlib.sha256(...).hexdigest()` so a hash
    // computed in either vertical (or supplied via secrets) resolves identically.
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// An [`Authenticator`] backed by a fixed set of API-key hashes -> [`Principal`].
#[derive(Debug, Clone, Default)]
pub struct ApiKeyAuthenticator {
    by_hash: HashMap<String, Principal>,
}

impl ApiKeyAuthenticator {
    /// Build from a mapping of SHA-256 key hex digests to principals.
    ///
    /// Prefer this when the hashes already live in a secret store: nothing here ever
    /// holds the plaintext key.
    #[must_use]
    pub fn new(key_hashes: HashMap<String, Principal>) -> Self {
        Self {
            by_hash: key_hashes,
        }
    }

    /// Build from plaintext keys, hashing each immediately so no plaintext is retained.
    ///
    /// Keys come from config/the [`crate::ports::SecretProvider`], never source. The
    /// returned authenticator stores only digests.
    #[must_use]
    pub fn from_keys(keys: HashMap<String, Principal>) -> Self {
        let by_hash = keys
            .into_iter()
            .map(|(key, principal)| (hash_api_key(&key), principal))
            .collect();
        Self { by_hash }
    }
}

impl Authenticator for ApiKeyAuthenticator {
    /// Return the principal for `credential` (an API key), else `Unauthenticated` (401).
    ///
    /// Lookup is by SHA-256 digest: the presented key is hashed and the digest is used
    /// as the map key, so the comparison is against fixed-size digests rather than the
    /// raw secret. Because the key is high-entropy, the hashed lookup is not a practical
    /// timing oracle for the key's contents (the same rationale as the Python adapter).
    fn authenticate(&self, credential: &str) -> Result<Principal, DomainError> {
        self.by_hash
            .get(&hash_api_key(credential))
            .cloned()
            .ok_or_else(|| DomainError::new(ErrorCategory::Unauthenticated, "invalid api key"))
    }
}

#[cfg(test)]
mod tests {
    use super::{hash_api_key, ApiKeyAuthenticator};
    use crate::auth::{Authenticator, Principal};
    use crate::domain::errors::ErrorCategory;
    use std::collections::{BTreeSet, HashMap};

    fn principal(scopes: &[&str]) -> Principal {
        Principal {
            subject: "svc-reporter".to_string(),
            scopes: scopes
                .iter()
                .map(ToString::to_string)
                .collect::<BTreeSet<_>>(),
            roles: BTreeSet::new(),
        }
    }

    #[test]
    fn hash_matches_known_sha256_vector() {
        // SHA-256 of "secret-key" (hex). Pins the digest so a hashing regression (wrong
        // encoding/casing) is caught, and documents cross-vertical compatibility with
        // Python's hashlib.sha256(...).hexdigest().
        assert_eq!(
            hash_api_key("secret-key"),
            "85dbe15d75ef9308c7ae0f33c7a324cc6f4bf519a2ed2f3027bd33c140a4f9aa"
        );
    }

    #[test]
    fn valid_key_yields_its_principal() {
        let authn = ApiKeyAuthenticator::from_keys(HashMap::from([(
            "k-live-123".to_string(),
            principal(&["items:read"]),
        )]));
        let resolved = authn.authenticate("k-live-123").expect("valid key");
        assert_eq!(resolved.subject, "svc-reporter");
        assert!(resolved.scopes.contains("items:read"));
    }

    #[test]
    fn wrong_key_is_unauthenticated() {
        let authn = ApiKeyAuthenticator::from_keys(HashMap::from([(
            "k-live-123".to_string(),
            principal(&["items:read"]),
        )]));
        let err = authn.authenticate("k-live-WRONG").unwrap_err();
        assert_eq!(err.category, ErrorCategory::Unauthenticated);
    }

    #[test]
    fn empty_authenticator_rejects_everything() {
        let authn = ApiKeyAuthenticator::default();
        assert_eq!(
            authn.authenticate("anything").unwrap_err().category,
            ErrorCategory::Unauthenticated
        );
    }

    #[test]
    fn from_keys_stores_only_hashes_not_plaintext() {
        // The plaintext key must never be a map key; only its digest is retained.
        let authn = ApiKeyAuthenticator::from_keys(HashMap::from([(
            "plaintext-key".to_string(),
            principal(&["items:read"]),
        )]));
        assert!(authn.by_hash.contains_key(&hash_api_key("plaintext-key")));
        assert!(!authn.by_hash.contains_key("plaintext-key"));
    }

    #[test]
    fn new_from_precomputed_hashes_resolves() {
        // The secrets-supplied path: construct straight from digests, no plaintext seen.
        let authn = ApiKeyAuthenticator::new(HashMap::from([(
            hash_api_key("k-live-123"),
            principal(&["items:write"]),
        )]));
        assert!(authn
            .authenticate("k-live-123")
            .expect("valid key")
            .scopes
            .contains("items:write"));
    }
}
