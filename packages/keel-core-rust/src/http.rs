//! HTTP inbound adapter: the axum application factory, edge middleware, and health
//! endpoints.
//!
//! `create_app` returns the base router with the uniform health probes
//! (`platform.yaml` health) and the always-on edge hardening (security headers,
//! body-size limit, request-id) plus opt-in deny-by-default CORS, mirroring the
//! keel-core-py edge. Auth-guarded service routes are layered on by the service
//! (slice #209 adds the authenticator and the deny-by-default conformance check).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::routing::get;
use axum::{Extension, Router};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::set_header::SetResponseHeaderLayer;

/// Default request body cap (1 MiB), bounding the large-payload DoS vector.
pub const DEFAULT_MAX_BODY_BYTES: usize = 1_048_576;

/// A readiness check: resolves to `true` when the service's dependencies (database,
/// broker, ...) are reachable. The composition root injects one via
/// [`create_app_with_readiness`]; the bare scaffold has none and reports ready.
pub type ReadinessCheck = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// Edge configuration for the app factory.
pub struct AppConfig {
    /// Maximum request body size in bytes.
    pub max_body_bytes: usize,
    /// Exact CORS origins to allow. Empty means deny-by-default (no CORS layer).
    pub cors_allow_origins: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            cors_allow_origins: Vec::new(),
        }
    }
}

/// Build the base application (health probes only) with default edge hardening.
pub fn create_app() -> Router {
    create_app_with(&AppConfig::default(), Router::new())
}

/// Build the application: the health probes plus the service's `routes`, all wrapped
/// in the edge middleware. Wrapping the merged router (not layering after) is what
/// makes the body limit and headers cover the service routes too.
///
/// Readiness reports ready unconditionally; use [`create_app_with_readiness`] to inject
/// a real dependency check.
pub fn create_app_with(config: &AppConfig, routes: Router) -> Router {
    create_app_with_readiness(config, routes, None)
}

/// Like [`create_app_with`], but with an injected [`ReadinessCheck`] so `/readyz` reports
/// `503` when a dependency is unreachable, instead of always `200`. The composition root
/// passes a closure that pings the datasource; the readiness probe can then gate traffic.
pub fn create_app_with_readiness(
    config: &AppConfig,
    routes: Router,
    readiness: Option<ReadinessCheck>,
) -> Router {
    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .merge(routes);

    // Make the readiness check available to the `/readyz` handler. Layered on the merged
    // app so the base health routes see it too.
    if let Some(check) = readiness {
        app = app.layer(Extension(check));
    }

    // Bound the request body size (415-style protection; returns 413 when exceeded).
    app = app.layer(RequestBodyLimitLayer::new(config.max_body_bytes));

    // Propagate a client x-request-id or mint a fresh UUID so logs/responses correlate.
    let request_id = HeaderName::from_static("x-request-id");
    app = app
        .layer(PropagateRequestIdLayer::new(request_id.clone()))
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid));

    // CORS is deny-by-default: the layer is added only when origins are configured,
    // and a wildcard is never combined with credentials.
    if !config.cors_allow_origins.is_empty() {
        app = app.layer(cors_layer(&config.cors_allow_origins));
    }

    // Always-on security headers, applied OUTERMOST so they also decorate responses that
    // short-circuit an inner layer (e.g. the body-limit 413), matching keel-core-py's
    // edge. if_not_present means a route may still override a header. HSTS is emitted
    // unconditionally: browsers ignore it over plaintext, so it is safe on http and
    // active behind a TLS-terminating proxy.
    for (name, value) in security_headers() {
        app = app.layer(SetResponseHeaderLayer::if_not_present(
            name,
            HeaderValue::from_static(value),
        ));
    }

    app
}

fn security_headers() -> [(HeaderName, &'static str); 6] {
    [
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; frame-ancestors 'none'",
        ),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::REFERRER_POLICY, "no-referrer"),
        (
            HeaderName::from_static("permissions-policy"),
            "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
        ),
        (
            header::STRICT_TRANSPORT_SECURITY,
            "max-age=31536000; includeSubDomains",
        ),
    ]
}

fn cors_layer(origins: &[String]) -> CorsLayer {
    // An explicit "*" means allow-all; map it to AllowOrigin::any() rather than passing it
    // to AllowOrigin::list, which panics on a wildcard entry. Credentials are never
    // enabled, so a wildcard origin stays spec-compliant.
    if origins.iter().any(|origin| origin == "*") {
        return CorsLayer::new().allow_origin(AllowOrigin::any());
    }
    let parsed: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|origin| origin.parse().ok())
        .collect();
    CorsLayer::new().allow_origin(AllowOrigin::list(parsed))
}

/// Liveness: the process is up.
async fn healthz() -> StatusCode {
    StatusCode::OK
}

/// Readiness: dependencies are reachable. Runs the injected [`ReadinessCheck`] when the
/// composition root supplied one (503 if it reports not-ready); the bare scaffold, with
/// no dependencies wired, reports ready.
async fn readyz(check: Option<Extension<ReadinessCheck>>) -> StatusCode {
    match check {
        Some(Extension(check)) if !check().await => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::OK,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        create_app, create_app_with, create_app_with_readiness, AppConfig, ReadinessCheck,
    };
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn readyz_status(readiness: Option<ReadinessCheck>) -> StatusCode {
        create_app_with_readiness(&AppConfig::default(), Router::new(), readiness)
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn readiness_reports_ready_without_a_check() {
        assert_eq!(readyz_status(None).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn readiness_reports_ready_when_the_check_passes() {
        let check: ReadinessCheck = Arc::new(|| Box::pin(async { true }));
        assert_eq!(readyz_status(Some(check)).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn readiness_reports_503_when_a_dependency_is_down() {
        let check: ReadinessCheck = Arc::new(|| Box::pin(async { false }));
        assert_eq!(
            readyz_status(Some(check)).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn liveness_is_ok() {
        let response = create_app()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn responses_carry_the_security_headers() {
        let response = create_app()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let headers = response.headers();
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["x-frame-options"], "DENY");
        assert!(headers.contains_key("content-security-policy"));
        assert!(headers.contains_key("referrer-policy"));
        assert!(headers.contains_key("permissions-policy"));
        assert!(headers.contains_key("strict-transport-security"));
    }

    #[tokio::test]
    async fn a_request_id_is_set_on_the_response() {
        let response = create_app()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(response.headers().contains_key("x-request-id"));
    }

    #[tokio::test]
    async fn cors_is_deny_by_default() {
        let response = create_app()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(!response
            .headers()
            .contains_key("access-control-allow-origin"));
    }

    #[tokio::test]
    async fn an_oversized_body_is_rejected() {
        // A service route that reads the body is wrapped by the edge body limit;
        // an over-limit read is rejected with 413.
        use axum::body::Bytes;
        use axum::routing::post;

        let config = AppConfig {
            max_body_bytes: 8,
            ..AppConfig::default()
        };
        let routes = Router::new().route("/echo", post(|_: Bytes| async { StatusCode::OK }));
        let response = create_app_with(&config, routes)
            .oneshot(
                Request::post("/echo")
                    .body(Body::from(vec![b'x'; 64]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        // The security headers are applied outermost, so even a body-limit 413 that
        // short-circuits the inner stack still carries them.
        let headers = response.headers();
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["x-frame-options"], "DENY");
        assert!(headers.contains_key("content-security-policy"));
    }

    #[tokio::test]
    async fn a_wildcard_cors_origin_does_not_panic_and_allows_any() {
        // "*" is a natural way to express allow-all; it must not panic the app factory.
        let config = AppConfig {
            cors_allow_origins: vec!["*".to_string()],
            ..AppConfig::default()
        };
        let response = create_app_with(&config, Router::new())
            .oneshot(
                Request::get("/healthz")
                    .header("origin", "https://anywhere.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
    }
}
