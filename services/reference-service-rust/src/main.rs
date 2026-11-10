//! Reference-service entrypoint: load config, wire real adapters (DB + OIDC/JWKS),
//! and serve the composed app.

use std::sync::Arc;
use std::time::Duration;

use keel_core::auth::OidcAuthenticator;
use keel_core::http::AppConfig;
use keel_core::jwks::JwksCache;
use keel_core::persistence::Database;
use keel_core::webauth::SharedAuthenticator;
use reference_service_rust::repository::SqlItemRepository;
use reference_service_rust::{build_app, ReferenceConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = ReferenceConfig::from_env()?;
    let tracer = keel_core::telemetry::init(
        &config.service_name,
        &config.version,
        &config.environment,
        &config.log_level,
        config.otlp_endpoint.as_deref(),
    );

    let database = Database::connect(&config.database_url).await?;
    // Dev convenience; production applies versioned migrations instead.
    SqlItemRepository::new(&database).ensure_schema().await?;

    // Verify tokens against the issuer's JWKS (https unless a dev-like environment).
    let jwks = Arc::new(JwksCache::new(&config.oidc_jwks_uri, config.is_dev_like())?);
    jwks.refresh().await?;
    // Refresh the JWKS in the background so IdP signing-key rotation does not cause an
    // auth outage until the next restart. The resolver below shares the cache's key map.
    let refresh_task = Arc::clone(&jwks)
        .spawn_background_refresh(Duration::from_secs(config.jwks_refresh_interval_secs));
    let authenticator: SharedAuthenticator = Arc::new(OidcAuthenticator::new(
        &config.oidc_issuer,
        &config.oidc_audience,
        60,
        jwks.resolver(),
    ));

    // Carry the operator's CORS allow-list from config into the edge (deny-by-default
    // when empty); other edge settings keep their defaults.
    let app_config = AppConfig {
        cors_allow_origins: config.cors_allow_origins.clone(),
        ..AppConfig::default()
    };
    let app = build_app(&database, authenticator, &app_config);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await?;
    tracing::info!("reference-service listening on 0.0.0.0:8000");

    // Drain in-flight requests on SIGTERM (rolling deploy) / Ctrl-C before exiting, so
    // clients are not cut mid-request and telemetry is flushed on a clean shutdown.
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    refresh_task.abort();
    if let Some(provider) = tracer {
        keel_core::telemetry::shutdown(provider);
    }
    Ok(())
}

/// Resolve when the process receives SIGTERM (Kubernetes) or Ctrl-C/SIGINT (local).
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
    tracing::info!("shutdown signal received; draining in-flight requests");
}
