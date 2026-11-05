//! Reference-service entrypoint: load config, wire real adapters (DB + OIDC/JWKS),
//! and serve the composed app.

use std::sync::Arc;

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
    keel_core::logging::init(&config.log_level);

    let database = Database::connect(&config.database_url).await?;
    // Dev convenience; production applies versioned migrations instead.
    SqlItemRepository::new(&database).ensure_schema().await?;

    // Verify tokens against the issuer's JWKS (https unless a dev-like environment).
    let jwks = JwksCache::new(&config.oidc_jwks_uri, config.is_dev_like())?;
    jwks.refresh().await?;
    let authenticator: SharedAuthenticator = Arc::new(OidcAuthenticator::new(
        &config.oidc_issuer,
        &config.oidc_audience,
        60,
        jwks.resolver(),
    ));

    let app = build_app(&database, authenticator, &AppConfig::default());
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await?;
    tracing::info!("reference-service listening on 0.0.0.0:8000");
    axum::serve(listener, app).await?;
    Ok(())
}
