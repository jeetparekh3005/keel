//! HTTP inbound adapter: the axum application factory, edge middleware, and health
//! endpoints.
//!
//! `create_app` returns the base router with the uniform health probes
//! (`platform.yaml` health) and the always-on edge hardening (security headers,
//! body-size limit, request-id) plus opt-in deny-by-default CORS, mirroring the
//! keel-core-py edge. Auth-guarded service routes are layered on by the service
//! (slice #209 adds the authenticator and the deny-by-default conformance check).

use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::routing::get;
use axum::Router;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::set_header::SetResponseHeaderLayer;

/// Default request body cap (1 MiB), bounding the large-payload DoS vector.
pub const DEFAULT_MAX_BODY_BYTES: usize = 1_048_576;

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
pub fn create_app_with(config: &AppConfig, routes: Router) -> Router {
    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .merge(routes);

    // Always-on security headers (set only if absent), matching keel-core-py's edge.
    // HSTS is emitted unconditionally: browsers ignore it over plaintext, so it is
    // safe on http and active behind a TLS-terminating proxy.
    for (name, value) in security_headers() {
        app = app.layer(SetResponseHeaderLayer::if_not_present(
            name,
            HeaderValue::from_static(value),
        ));
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

/// Readiness: dependencies are reachable. A real dependency check is injected by the
/// service in a later slice; the core scaffold reports ready.
async fn readyz() -> StatusCode {
    StatusCode::OK
}

#[cfg(test)]
mod tests {
    use super::{create_app, create_app_with, AppConfig};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

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
    }
}
