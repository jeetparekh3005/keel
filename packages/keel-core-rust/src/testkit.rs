//! Test kit (ADR-0009 Tier-1): an in-memory fake for every driven port, plus the
//! behavioral contract-conformance suite a service runs against its own app to prove
//! it honors `platform.yaml`. Shipped so every vertical tests by contract.

use std::collections::HashMap;
use std::time::SystemTime;

use crate::auth::{Authenticator, Principal};
use crate::domain::errors::{DomainError, ErrorCategory};
use crate::ports::{Clock, SecretProvider};

/// A [`Clock`] frozen at a fixed instant.
pub struct FrozenClock(pub SystemTime);

impl Clock for FrozenClock {
    fn now(&self) -> SystemTime {
        self.0
    }
}

/// A dict-backed [`SecretProvider`].
#[derive(Default)]
pub struct InMemorySecretProvider {
    secrets: HashMap<String, String>,
}

impl InMemorySecretProvider {
    /// Create a provider seeded with `secrets`.
    #[must_use]
    pub fn new(secrets: HashMap<String, String>) -> Self {
        Self { secrets }
    }
}

impl SecretProvider for InMemorySecretProvider {
    fn get(&self, key: &str) -> Option<String> {
        self.secrets.get(key).cloned()
    }
}

/// An [`Authenticator`] that maps known opaque tokens to principals; anything else is
/// rejected. For wiring tests without a real IdP.
#[derive(Default)]
pub struct StubAuthenticator {
    principals: HashMap<String, Principal>,
}

impl StubAuthenticator {
    /// Create a stub that accepts the given `token -> principal` mappings.
    #[must_use]
    pub fn new(principals: HashMap<String, Principal>) -> Self {
        Self { principals }
    }
}

impl Authenticator for StubAuthenticator {
    fn authenticate(&self, credential: &str) -> Result<Principal, DomainError> {
        self.principals
            .get(credential)
            .cloned()
            .ok_or_else(|| DomainError::new(ErrorCategory::Unauthenticated, "invalid token"))
    }
}

/// Behavioral contract-conformance checks a service runs against its router.
///
/// Each maps a `platform.yaml` claim to an assertion against the composed app, so an
/// over-claim or broken wiring fails a test rather than shipping (the Rust mirror of
/// `keel_core.testkit.contract`). The per-signal claims (tracing/log correlation,
/// metrics) are covered by keel-core's own suites.
pub mod conformance {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::response::Response;
    use axum::Router;
    use tower::ServiceExt;

    async fn get(router: Router, path: &str) -> Response {
        router
            .oneshot(Request::get(path).body(Body::empty()).expect("request"))
            .await
            .expect("response")
    }

    /// platform.yaml health: `/healthz` is 200 and `/readyz` is 200 or 503.
    pub async fn assert_health(router: &Router) {
        assert_eq!(
            get(router.clone(), "/healthz").await.status(),
            StatusCode::OK,
            "/healthz must return 200"
        );
        let ready = get(router.clone(), "/readyz").await.status();
        assert!(
            ready == StatusCode::OK || ready == StatusCode::SERVICE_UNAVAILABLE,
            "/readyz must return 200 or 503, got {ready}"
        );
    }

    /// platform.yaml http.security_headers: the always-on headers are present.
    pub async fn assert_security_headers(router: &Router) {
        let response = get(router.clone(), "/healthz").await;
        let headers = response.headers();
        for required in [
            "content-security-policy",
            "x-content-type-options",
            "x-frame-options",
            "referrer-policy",
            "permissions-policy",
        ] {
            assert!(
                headers.contains_key(required),
                "missing security header {required}"
            );
        }
        assert_eq!(headers["x-content-type-options"], "nosniff");
    }

    /// platform.yaml http.cors: deny-by-default (no CORS headers without configured origins).
    pub async fn assert_cors_deny_by_default(router: &Router) {
        let response = get(router.clone(), "/healthz").await;
        assert!(
            !response
                .headers()
                .contains_key("access-control-allow-origin"),
            "CORS must be deny-by-default"
        );
    }

    /// platform.yaml auth: a protected route denies an unauthenticated caller (401).
    pub async fn assert_denies_anonymous(router: &Router, path: &str) {
        let status = get(router.clone(), path).await.status();
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{path} must deny anonymous access with 401, got {status}"
        );
    }

    async fn send(
        router: Router,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        json_body: Option<&str>,
    ) -> Response {
        let mut builder = Request::builder().method(method).uri(path);
        if let Some(token) = bearer {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let body = match json_body {
            Some(json) => {
                builder = builder.header("content-type", "application/json");
                Body::from(json.to_owned())
            }
            None => Body::empty(),
        };
        router
            .oneshot(builder.body(body).expect("request"))
            .await
            .expect("response")
    }

    /// platform.yaml auth: a protected route denies an unauthenticated caller (401) for a
    /// given method. Unlike [`assert_denies_anonymous`] (GET only), this covers mutating
    /// routes, so a handler that forgets the `Authed` extractor fails this assertion.
    /// axum has no route introspection like FastAPI's, so a service enumerates its routes
    /// through this helper to get the deny-by-default conformance guarantee.
    pub async fn assert_method_denies_anonymous(
        router: &Router,
        method: &str,
        path: &str,
        json_body: Option<&str>,
    ) {
        let status = send(router.clone(), method, path, None, json_body)
            .await
            .status();
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{method} {path} must deny anonymous access with 401, got {status}"
        );
    }

    /// platform.yaml auth (deny-by-default authz): an authenticated caller lacking the
    /// route's required scope is forbidden (403). `insufficient_bearer` is a token the
    /// app's authenticator accepts but whose principal lacks the scope.
    pub async fn assert_requires_scope(
        router: &Router,
        method: &str,
        path: &str,
        insufficient_bearer: &str,
        json_body: Option<&str>,
    ) {
        let status = send(
            router.clone(),
            method,
            path,
            Some(insufficient_bearer),
            json_body,
        )
        .await
        .status();
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "{method} {path} must forbid an insufficient-scope caller with 403, got {status}"
        );
    }

    /// platform.yaml errors: the response is an RFC 9457 problem+json with the expected
    /// status and the `type`/`title`/`status` fields.
    pub async fn assert_problem_response(response: Response, status: StatusCode) {
        assert_eq!(response.status(), status, "unexpected status");
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            content_type.starts_with("application/problem+json"),
            "errors must be problem+json, got {content_type}"
        );
        let bytes = http_body_util::BodyExt::collect(response.into_body())
            .await
            .expect("body")
            .to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).expect("json body");
        for field in ["type", "title", "status"] {
            assert!(body.get(field).is_some(), "problem+json missing {field}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FrozenClock, InMemorySecretProvider, StubAuthenticator};
    use crate::auth::{Authenticator, Principal};
    use crate::domain::errors::ErrorCategory;
    use crate::ports::{Clock, SecretProvider};
    use std::collections::{BTreeSet, HashMap};
    use std::time::{Duration, SystemTime};

    #[test]
    fn frozen_clock_returns_its_fixed_instant() {
        let instant = SystemTime::UNIX_EPOCH + Duration::from_secs(42);
        assert_eq!(FrozenClock(instant).now(), instant);
    }

    #[test]
    fn in_memory_secret_provider_round_trips() {
        let provider =
            InMemorySecretProvider::new(HashMap::from([("k".to_string(), "v".to_string())]));
        assert_eq!(provider.get("k").as_deref(), Some("v"));
        assert!(provider.get("missing").is_none());
    }

    #[tokio::test]
    async fn conformance_suite_passes_for_the_base_app() {
        use super::conformance;
        let app = crate::http::create_app();
        conformance::assert_health(&app).await;
        conformance::assert_security_headers(&app).await;
        conformance::assert_cors_deny_by_default(&app).await;
    }

    #[test]
    fn stub_authenticator_accepts_known_tokens_and_rejects_others() {
        let principal = Principal {
            subject: "user-1".to_string(),
            scopes: BTreeSet::from(["items:read".to_string()]),
            roles: BTreeSet::new(),
        };
        let stub = StubAuthenticator::new(HashMap::from([("tok".to_string(), principal)]));
        assert_eq!(stub.authenticate("tok").unwrap().subject, "user-1");
        let err = stub.authenticate("nope").unwrap_err();
        assert_eq!(err.category, ErrorCategory::Unauthenticated);
    }
}
