//! HTTP inbound adapter: the axum application factory and health endpoints.
//!
//! `create_app` returns the base router with the uniform health probes
//! (`platform.yaml` health). The edge middleware stack (CORS deny-by-default,
//! request-id, security headers, body limit, rate limit) and the auth-guarded
//! service routes are layered on in later slices (#208 continued, #209).

use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;

/// Build the base application router: liveness and readiness probes.
#[must_use]
pub fn create_app() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
}

/// Liveness: the process is up.
async fn healthz() -> StatusCode {
    StatusCode::OK
}

/// Readiness: dependencies are reachable. A real readiness check (DB, auth) is
/// injected in a later slice; the scaffold reports ready.
async fn readyz() -> StatusCode {
    StatusCode::OK
}

#[cfg(test)]
mod tests {
    use super::{healthz, readyz};
    use axum::http::StatusCode;

    #[tokio::test]
    async fn liveness_is_ok() {
        assert_eq!(healthz().await, StatusCode::OK);
    }

    #[tokio::test]
    async fn readiness_is_ok() {
        assert_eq!(readyz().await, StatusCode::OK);
    }
}
