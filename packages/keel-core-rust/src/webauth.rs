//! axum integration for authentication/authorization (the deny-by-default edge).
//!
//! A handler that takes [`Authed`] is protected: a request authenticates via EITHER an
//! `X-API-Key` header (verified by the [`ApiKeyAuthenticator`]) OR a Bearer JWT (the
//! [`Authenticator`] extension). A missing or invalid credential is rejected before the
//! handler runs (401), a key-source outage is a 503, and scope checks return 403 - all
//! rendered as RFC 9457 problem+json, and the same deny-by-default scope check applies
//! whichever credential produced the [`Principal`]. Public routes simply do not take
//! [`Authed`]. The authenticators are provided via request extensions (see
//! [`authenticator_layer`] and [`api_key_authenticator_layer`]).

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Extension;

use crate::api_key::ApiKeyAuthenticator;
use crate::auth::{Authenticator, Principal};
use crate::domain::errors::{DomainError, ErrorCategory};

/// The header that carries an opaque API key (the non-Bearer credential).
const API_KEY_HEADER: &str = "x-api-key";

/// A shared authenticator, attached to the router as a request extension.
pub type SharedAuthenticator = Arc<dyn Authenticator>;

/// A shared API-key authenticator, attached as a distinct request extension so it never
/// collides with the Bearer [`SharedAuthenticator`] in the type-keyed extension map.
pub type SharedApiKeyAuthenticator = Arc<ApiKeyAuthenticator>;

/// The extension layer that makes `authenticator` available to the [`Authed`] extractor.
pub fn authenticator_layer(authenticator: SharedAuthenticator) -> Extension<SharedAuthenticator> {
    Extension(authenticator)
}

/// The extension layer that enables the `X-API-Key` path for the [`Authed`] extractor.
///
/// Optional: a service that layers it accepts API keys in addition to Bearer JWTs; a
/// service that does not keeps the Bearer-only behavior. Either way the resulting
/// [`Principal`] flows into the same scope checks.
pub fn api_key_authenticator_layer(
    authenticator: SharedApiKeyAuthenticator,
) -> Extension<SharedApiKeyAuthenticator> {
    Extension(authenticator)
}

/// Render a domain error as an RFC 9457 problem+json response.
impl IntoResponse for DomainError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.category.status())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        // Server-fault detail is dropped from the client body (never leak internals);
        // log it here so operators keep the diagnostic.
        if self.category.is_server_fault() {
            tracing::error!(
                category = self.category.slug(),
                detail = %self.detail,
                "request failed with a server-side fault"
            );
        }
        let body = serde_json::to_vec(&self.to_problem(None)).unwrap_or_default();
        (status, [(CONTENT_TYPE, "application/problem+json")], body).into_response()
    }
}

/// An authenticated caller. Taking this extractor on a handler makes the route require
/// a valid Bearer token (deny-by-default).
pub struct Authed(pub Principal);

impl Authed {
    /// Require that the caller holds every scope in `required`, else `Forbidden` (403).
    ///
    /// # Errors
    /// Returns a `Forbidden` [`DomainError`] if any required scope is missing.
    pub fn require_scopes(&self, required: &[&str]) -> Result<(), DomainError> {
        if required.iter().all(|scope| self.0.scopes.contains(*scope)) {
            Ok(())
        } else {
            Err(DomainError::new(
                ErrorCategory::Forbidden,
                "insufficient scope",
            ))
        }
    }
}

impl<S> FromRequestParts<S> for Authed
where
    S: Send + Sync,
{
    type Rejection = DomainError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // EITHER/OR credential resolution. An explicit `X-API-Key` header takes the
        // API-key path; otherwise the Bearer/JWT path runs unchanged. Whichever
        // produces the Principal, it flows into the same `require_scopes` check, so an
        // API-key caller is just as subject to deny-by-default as a Bearer caller.
        if let Some(key) = api_key_header(parts) {
            let authenticator = parts
                .extensions
                .get::<SharedApiKeyAuthenticator>()
                .ok_or_else(|| {
                    // The caller presented an API key but this service accepts none:
                    // an unknown credential, so 401 (not a 500) and no config is leaked.
                    DomainError::new(
                        ErrorCategory::Unauthenticated,
                        "api-key authentication is not enabled",
                    )
                })?;
            let principal = authenticator.authenticate(key)?;
            return Ok(Authed(principal));
        }
        let authenticator = parts
            .extensions
            .get::<SharedAuthenticator>()
            .ok_or_else(|| {
                DomainError::new(ErrorCategory::Internal, "authenticator not configured")
            })?;
        let token = bearer_token(parts).ok_or_else(|| {
            DomainError::new(ErrorCategory::Unauthenticated, "missing bearer token")
        })?;
        let principal = authenticator.authenticate(token)?;
        Ok(Authed(principal))
    }
}

fn bearer_token(parts: &Parts) -> Option<&str> {
    // RFC 7235 auth-scheme is case-insensitive, so accept any casing of "bearer".
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

fn api_key_header(parts: &Parts) -> Option<&str> {
    // An empty or non-ASCII header value is treated as absent, so it falls through to
    // the Bearer path rather than forcing a failed API-key lookup.
    let key = parts.headers.get(API_KEY_HEADER)?.to_str().ok()?.trim();
    (!key.is_empty()).then_some(key)
}

#[cfg(test)]
mod tests {
    use super::{
        api_key_authenticator_layer, authenticator_layer, Authed, SharedApiKeyAuthenticator,
        SharedAuthenticator,
    };
    use crate::api_key::ApiKeyAuthenticator;
    use crate::auth::Principal;
    use crate::domain::errors::ErrorCategory;
    use crate::testkit::StubAuthenticator;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Router;
    use std::collections::{BTreeSet, HashMap};
    use std::sync::Arc;
    use tower::ServiceExt;

    fn principal(scopes: &[&str]) -> Principal {
        Principal {
            subject: "user-1".to_string(),
            scopes: scopes
                .iter()
                .map(ToString::to_string)
                .collect::<BTreeSet<_>>(),
            roles: BTreeSet::new(),
        }
    }

    fn routes() -> Router {
        Router::new()
            .route(
                "/protected",
                get(|authed: Authed| async move {
                    authed.require_scopes(&["items:read"])?;
                    Ok::<_, crate::domain::errors::DomainError>(StatusCode::OK)
                }),
            )
            .route(
                "/needs-write",
                get(|authed: Authed| async move {
                    authed.require_scopes(&["items:write"])?;
                    Ok::<_, crate::domain::errors::DomainError>(StatusCode::OK)
                }),
            )
    }

    fn app() -> Router {
        let authenticator: SharedAuthenticator =
            Arc::new(StubAuthenticator::new(HashMap::from([(
                "tok".to_string(),
                principal(&["items:read"]),
            )])));
        routes().layer(authenticator_layer(authenticator))
    }

    // An app wiring BOTH paths: the Bearer stub ("tok" -> items:read) and an API-key
    // authenticator ("k-read" -> items:read, "k-norole" -> an unrelated scope). Used to
    // prove the EITHER/OR resolution and that deny-by-default still applies to API keys.
    fn app_with_api_keys() -> Router {
        let bearer: SharedAuthenticator = Arc::new(StubAuthenticator::new(HashMap::from([(
            "tok".to_string(),
            principal(&["items:read"]),
        )])));
        let api_keys: SharedApiKeyAuthenticator =
            Arc::new(ApiKeyAuthenticator::from_keys(HashMap::from([
                ("k-read".to_string(), principal(&["items:read"])),
                ("k-norole".to_string(), principal(&["unrelated:scope"])),
            ])));
        routes()
            .layer(api_key_authenticator_layer(api_keys))
            .layer(authenticator_layer(bearer))
    }

    async fn call(path: &str, auth: Option<&str>) -> StatusCode {
        let mut builder = Request::get(path);
        if let Some(token) = auth {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        app()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    async fn call_api_key(path: &str, key: Option<&str>) -> StatusCode {
        let mut builder = Request::get(path);
        if let Some(key) = key {
            builder = builder.header("x-api-key", key);
        }
        app_with_api_keys()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn missing_token_is_401() {
        assert_eq!(call("/protected", None).await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn invalid_token_is_401() {
        assert_eq!(
            call("/protected", Some("bogus")).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn valid_token_with_scope_is_200() {
        assert_eq!(call("/protected", Some("tok")).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn valid_token_missing_scope_is_403() {
        assert_eq!(
            call("/needs-write", Some("tok")).await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn lowercase_bearer_scheme_is_accepted() {
        // RFC 7235 makes the auth-scheme case-insensitive; a lowercase "bearer" is valid.
        let response = app()
            .oneshot(
                Request::get("/protected")
                    .header("authorization", "bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn valid_api_key_with_scope_is_200() {
        // An X-API-Key caller whose principal holds the required scope passes the same
        // scope-guarded route a Bearer caller would.
        assert_eq!(
            call_api_key("/protected", Some("k-read")).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn wrong_api_key_is_401() {
        assert_eq!(
            call_api_key("/protected", Some("k-bogus")).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn absent_credential_is_401() {
        // Neither header present: deny-by-default rejects before the handler runs.
        assert_eq!(
            call_api_key("/protected", None).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn api_key_principal_missing_scope_is_403() {
        // "k-norole" authenticates (401 would be wrong) but lacks items:write, so the
        // deny-by-default scope check still returns 403 - an API-key principal is not
        // privileged past the route's required scope.
        assert_eq!(
            call_api_key("/needs-write", Some("k-norole")).await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn bearer_path_unchanged_when_api_keys_enabled() {
        // With the API-key layer present, a Bearer JWT (no X-API-Key header) still
        // resolves via the Bearer authenticator exactly as before.
        let status = app_with_api_keys()
            .oneshot(
                Request::get("/protected")
                    .header("authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status();
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn api_key_header_takes_precedence_over_bearer() {
        // When both headers are present, X-API-Key wins. A bogus key therefore 401s even
        // though the Bearer token is valid - the resolution is header-driven, not a
        // fallback cascade.
        let status = app_with_api_keys()
            .oneshot(
                Request::get("/protected")
                    .header("x-api-key", "k-bogus")
                    .header("authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn api_key_without_api_key_layer_is_401() {
        // The Bearer-only app has no API-key authenticator; presenting an API key is an
        // unknown credential (401), never a 500.
        let status = app()
            .oneshot(
                Request::get("/protected")
                    .header("x-api-key", "k-read")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn domain_error_renders_problem_json() {
        let response = crate::domain::errors::DomainError::new(ErrorCategory::NotFound, "gone")
            .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers()["content-type"],
            "application/problem+json"
        );
    }

    #[tokio::test]
    async fn server_fault_response_body_omits_internal_detail() {
        use http_body_util::BodyExt;
        let response = crate::domain::errors::DomainError::new(
            ErrorCategory::Internal,
            "commit: duplicate key value violates unique constraint \"items_pkey\"",
        )
        .into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(
            body.get("detail").is_none(),
            "a 500 body must not leak internal detail: {body}"
        );
        assert_eq!(body["status"], 500);
    }
}
