//! OIDC / JWT authentication (platform.yaml auth; ADR-0006).
//!
//! Verifies a Bearer JWT against the issuer's signing key, checks issuer/audience/
//! expiry, and maps claims to a [`Principal`]. Mirrors the hardened Python semantics:
//! RS256 only (no alg confusion), `exp`/`iss`/`aud`/`sub` required, clock-skew leeway,
//! and a key resolver whose "not found" maps to 401 while "unavailable" maps to 503 -
//! so an unknown `kid` or a JWKS outage never surfaces as a 500. Signing-key fetching
//! (JWKS over HTTPS, with caching) plugs in via the resolver; this module owns the
//! verification and claim-to-principal logic.

use std::collections::BTreeSet;

use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

use crate::domain::errors::{DomainError, ErrorCategory};

/// An authenticated caller: a stable subject plus granted scopes and roles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub subject: String,
    pub scopes: BTreeSet<String>,
    pub roles: BTreeSet<String>,
}

/// Verifies a credential and returns the [`Principal`], else a [`DomainError`].
pub trait Authenticator: Send + Sync {
    /// Authenticate a raw credential (a JWT), returning the caller's principal.
    ///
    /// # Errors
    /// `Unauthenticated` (401) for an invalid/expired/forged/unknown-key token;
    /// `Unavailable` (503) when the signing-key source cannot be reached.
    fn authenticate(&self, credential: &str) -> Result<Principal, DomainError>;
}

/// Why a signing key could not be produced by the resolver.
pub enum KeyLookupError {
    /// No key matched the token's `kid` (treated as an invalid token, 401).
    NotFound,
    /// The key source (e.g. a JWKS endpoint) was unreachable (retryable, 503).
    Unavailable(String),
}

/// Resolves a JWT `kid` to its decoding key. A JWKS client implements this; tests
/// inject a static key.
pub type KeyResolver =
    Box<dyn Fn(Option<&str>) -> Result<DecodingKey, KeyLookupError> + Send + Sync>;

/// An OIDC/JWT authenticator.
pub struct OidcAuthenticator {
    validation: Validation,
    key_resolver: KeyResolver,
}

// exp/iss/aud are validated by jsonwebtoken from the token itself (see Validation),
// so they are not fields here; we only deserialize what becomes the Principal.
#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    scp: Option<ScopeClaim>,
    #[serde(default)]
    roles: Option<Vec<String>>,
    #[serde(default)]
    realm_access: Option<RealmAccess>,
}

/// The `scp` claim is an array of scopes in most IdPs, but the Microsoft identity
/// platform (Entra ID / Azure AD) emits it as a single space-delimited string. Accept
/// both shapes so a valid token is not rejected because of its scope encoding.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ScopeClaim {
    List(Vec<String>),
    Spaced(String),
}

impl ScopeClaim {
    fn into_scopes(self) -> Vec<String> {
        match self {
            Self::List(scopes) => scopes,
            Self::Spaced(scopes) => scopes.split_whitespace().map(ToString::to_string).collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RealmAccess {
    #[serde(default)]
    roles: Vec<String>,
}

impl OidcAuthenticator {
    /// Build an authenticator for `issuer`/`audience` using `key_resolver`, tolerating
    /// `leeway_secs` of clock skew on `exp`/`nbf`.
    #[must_use]
    pub fn new(issuer: &str, audience: &str, leeway_secs: u64, key_resolver: KeyResolver) -> Self {
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[issuer]);
        validation.set_audience(&[audience]);
        validation.leeway = leeway_secs;
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        Self {
            validation,
            key_resolver,
        }
    }

    fn unauthenticated() -> DomainError {
        DomainError::new(ErrorCategory::Unauthenticated, "invalid token")
    }
}

impl Authenticator for OidcAuthenticator {
    fn authenticate(&self, credential: &str) -> Result<Principal, DomainError> {
        let header = decode_header(credential).map_err(|_| Self::unauthenticated())?;
        let key = (self.key_resolver)(header.kid.as_deref()).map_err(|error| match error {
            KeyLookupError::NotFound => Self::unauthenticated(),
            KeyLookupError::Unavailable(message) => {
                DomainError::new(ErrorCategory::Unavailable, message)
            }
        })?;
        let data = decode::<Claims>(credential, &key, &self.validation)
            .map_err(|_| Self::unauthenticated())?;
        Ok(principal_from(data.claims))
    }
}

fn principal_from(claims: Claims) -> Principal {
    let mut scopes = BTreeSet::new();
    if let Some(scope) = claims.scope {
        scopes.extend(scope.split_whitespace().map(ToString::to_string));
    }
    if let Some(scp) = claims.scp {
        scopes.extend(scp.into_scopes());
    }
    let mut roles = BTreeSet::new();
    if let Some(list) = claims.roles {
        roles.extend(list);
    }
    if let Some(realm) = claims.realm_access {
        roles.extend(realm.roles);
    }
    Principal {
        subject: claims.sub,
        scopes,
        roles,
    }
}

#[cfg(test)]
mod tests {
    use super::{Authenticator, KeyLookupError, OidcAuthenticator};
    use crate::domain::errors::ErrorCategory;
    use jsonwebtoken::{encode, Algorithm, DecodingKey, EncodingKey, Header};
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
    use rsa::PrivateKey;
    use std::sync::OnceLock;
    use std::time::{SystemTime, UNIX_EPOCH};

    const ISSUER: &str = "https://issuer.example";
    const AUDIENCE: &str = "keel-api";

    struct TestKeys {
        signing_pem: String,
        public_pem: String,
        other_signing_pem: String,
    }

    // Generate two ephemeral RSA keypairs once for the whole test run (keygen is slow).
    fn keys() -> &'static TestKeys {
        static KEYS: OnceLock<TestKeys> = OnceLock::new();
        KEYS.get_or_init(|| {
            let generate = || {
                let mut rng = rand::rng();
                PrivateKey::new(&mut rng, 2048).expect("rsa keygen")
            };
            let main = generate();
            let other = generate();
            TestKeys {
                signing_pem: main.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
                public_pem: main
                    .to_public_key()
                    .to_public_key_pem(LineEnding::LF)
                    .unwrap(),
                other_signing_pem: other.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
            }
        })
    }

    fn now() -> usize {
        usize::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        )
        .unwrap()
    }

    fn token(signing_pem: &str, claims: &serde_json::Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test-key".to_string());
        let key = EncodingKey::from_rsa_pem(signing_pem.as_bytes()).unwrap();
        encode(&header, claims, &key).unwrap()
    }

    fn valid_claims() -> serde_json::Value {
        serde_json::json!({
            "sub": "user-1",
            "iss": ISSUER,
            "aud": AUDIENCE,
            "exp": now() + 3600,
            "scope": "orders:read orders:write",
            "realm_access": { "roles": ["admin"] },
        })
    }

    fn authenticator_with(resolver: super::KeyResolver) -> OidcAuthenticator {
        OidcAuthenticator::new(ISSUER, AUDIENCE, 60, resolver)
    }

    fn pub_resolver() -> super::KeyResolver {
        Box::new(|_kid| Ok(DecodingKey::from_rsa_pem(keys().public_pem.as_bytes()).unwrap()))
    }

    #[test]
    fn valid_token_yields_principal() {
        let principal = authenticator_with(pub_resolver())
            .authenticate(&token(&keys().signing_pem, &valid_claims()))
            .expect("valid token");
        assert_eq!(principal.subject, "user-1");
        assert!(principal.scopes.contains("orders:read"));
        assert!(principal.roles.contains("admin"));
    }

    #[test]
    fn scp_claim_as_array_populates_scopes() {
        let claims = serde_json::json!({
            "sub": "user-1", "iss": ISSUER, "aud": AUDIENCE, "exp": now() + 3600,
            "scp": ["orders:read", "orders:write"],
        });
        let principal = authenticator_with(pub_resolver())
            .authenticate(&token(&keys().signing_pem, &claims))
            .expect("array scp token");
        assert!(principal.scopes.contains("orders:read"));
        assert!(principal.scopes.contains("orders:write"));
    }

    #[test]
    fn scp_claim_as_space_delimited_string_is_accepted() {
        // Microsoft Entra ID / Azure AD emits scp as a space-delimited string, not an array.
        let claims = serde_json::json!({
            "sub": "user-1", "iss": ISSUER, "aud": AUDIENCE, "exp": now() + 3600,
            "scp": "orders:read orders:write",
        });
        let principal = authenticator_with(pub_resolver())
            .authenticate(&token(&keys().signing_pem, &claims))
            .expect("Entra-style string scp token must be accepted");
        assert!(principal.scopes.contains("orders:read"));
        assert!(principal.scopes.contains("orders:write"));
    }

    #[test]
    fn expired_token_is_unauthenticated() {
        let mut claims = valid_claims();
        claims["exp"] = serde_json::json!(now() - 3600);
        let err = authenticator_with(pub_resolver())
            .authenticate(&token(&keys().signing_pem, &claims))
            .unwrap_err();
        assert_eq!(err.category, ErrorCategory::Unauthenticated);
    }

    #[test]
    fn clock_skew_within_leeway_is_accepted() {
        let mut claims = valid_claims();
        claims["exp"] = serde_json::json!(now() - 30); // expired 30s ago, within 60s leeway
        assert!(authenticator_with(pub_resolver())
            .authenticate(&token(&keys().signing_pem, &claims))
            .is_ok());
    }

    #[test]
    fn wrong_audience_is_unauthenticated() {
        let mut claims = valid_claims();
        claims["aud"] = serde_json::json!("someone-else");
        assert!(authenticator_with(pub_resolver())
            .authenticate(&token(&keys().signing_pem, &claims))
            .is_err());
    }

    #[test]
    fn wrong_issuer_is_unauthenticated() {
        let mut claims = valid_claims();
        claims["iss"] = serde_json::json!("https://evil.example");
        assert!(authenticator_with(pub_resolver())
            .authenticate(&token(&keys().signing_pem, &claims))
            .is_err());
    }

    #[test]
    fn forged_signature_is_unauthenticated() {
        // Signed with a different key than the resolver returns.
        let err = authenticator_with(pub_resolver())
            .authenticate(&token(&keys().other_signing_pem, &valid_claims()))
            .unwrap_err();
        assert_eq!(err.category, ErrorCategory::Unauthenticated);
    }

    #[test]
    fn garbage_token_is_unauthenticated() {
        assert!(authenticator_with(pub_resolver())
            .authenticate("not-a-jwt")
            .is_err());
    }

    #[test]
    fn unknown_kid_is_unauthenticated_not_500() {
        let resolver: super::KeyResolver = Box::new(|_kid| Err(KeyLookupError::NotFound));
        let err = authenticator_with(resolver)
            .authenticate(&token(&keys().signing_pem, &valid_claims()))
            .unwrap_err();
        assert_eq!(err.category, ErrorCategory::Unauthenticated);
    }

    #[test]
    fn key_source_outage_is_unavailable() {
        let resolver: super::KeyResolver =
            Box::new(|_kid| Err(KeyLookupError::Unavailable("jwks down".to_string())));
        let err = authenticator_with(resolver)
            .authenticate(&token(&keys().signing_pem, &valid_claims()))
            .unwrap_err();
        assert_eq!(err.category, ErrorCategory::Unavailable);
    }
}
