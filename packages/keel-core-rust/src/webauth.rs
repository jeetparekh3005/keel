//! axum integration for authentication/authorization (the deny-by-default edge).
//!
//! A handler that takes [`Authed`] is protected: a missing or invalid Bearer token is
//! rejected before the handler runs (401), a key-source outage is a 503, and scope
//! checks return 403 - all rendered as RFC 9457 problem+json. Public routes simply do
//! not take [`Authed`]. The shared [`Authenticator`] is provided via a request
//! extension (see [`authenticator_layer`]).

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Extension;

use crate::auth::{Authenticator, Principal};
use crate::domain::errors::{DomainError, ErrorCategory};

/// A shared authenticator, attached to the router as a request extension.
pub type SharedAuthenticator = Arc<dyn Authenticator>;

/// The extension layer that makes `authenticator` available to the [`Authed`] extractor.
pub fn authenticator_layer(authenticator: SharedAuthenticator) -> Extension<SharedAuthenticator> {
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

#[cfg(test)]
mod tests {
    use super::{authenticator_layer, Authed, SharedAuthenticator};
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

    fn app() -> Router {
        let principal = Principal {
            subject: "user-1".to_string(),
            scopes: BTreeSet::from(["items:read".to_string()]),
            roles: BTreeSet::new(),
        };
        let authenticator: SharedAuthenticator =
            Arc::new(StubAuthenticator::new(HashMap::from([(
                "tok".to_string(),
                principal,
            )])));
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
            .layer(authenticator_layer(authenticator))
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
