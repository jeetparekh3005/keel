//! Reference-service configuration (KEEL_-prefixed env, loaded via keel-core).

use keel_core::domain::errors::DomainError;
use serde::Deserialize;

/// Typed service configuration. Secure by default: `environment` defaults to
/// `production`, so the JWKS endpoint must be https unless an explicit dev environment
/// opts in (see [`ServiceConfig::is_dev_like`]).
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceConfig {
    #[serde(default = "default_service_name")]
    pub service_name: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default = "default_environment")]
    pub environment: String,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default = "default_database_url")]
    pub database_url: String,
    pub oidc_issuer: String,
    pub oidc_audience: String,
    pub oidc_jwks_uri: String,
    /// OTLP collector endpoint; traces export only when set.
    #[serde(default)]
    pub otlp_endpoint: Option<String>,
    /// How often (seconds) to refresh the JWKS in the background, so IdP signing-key
    /// rotation is tolerated without a restart.
    #[serde(default = "default_jwks_refresh_interval_secs")]
    pub jwks_refresh_interval_secs: u64,
    /// Exact CORS origins to allow. Empty (the default) is deny-by-default (no CORS).
    /// From `KEEL_CORS_ALLOW_ORIGINS`, parsed by figment as an array, e.g.
    /// `["https://app.example"]`.
    #[serde(default)]
    pub cors_allow_origins: Vec<String>,
    /// TCP port to bind. The Helm chart renders this from `service.port`, so the
    /// container, probes, and Service all agree on the listen port.
    #[serde(default = "default_port")]
    pub port: u16,
}

fn default_service_name() -> String {
    "@< service_name >@".to_string()
}
fn default_version() -> String {
    "0.0.0".to_string()
}
fn default_environment() -> String {
    "production".to_string()
}
fn default_log_level() -> String {
    "info".to_string()
}
fn default_database_url() -> String {
    "postgres://localhost/keel".to_string()
}
fn default_jwks_refresh_interval_secs() -> u64 {
    300
}
fn default_port() -> u16 {
    8000
}

impl ServiceConfig {
    /// Load from `KEEL_`-prefixed environment variables (fail-fast on missing OIDC).
    ///
    /// # Errors
    /// Returns a [`DomainError`] if required config is missing or malformed.
    pub fn from_env() -> Result<Self, DomainError> {
        keel_core::config::load(None)
    }

    /// True in a dev-like environment (allows a non-https JWKS endpoint for local dev).
    #[must_use]
    pub fn is_dev_like(&self) -> bool {
        matches!(
            self.environment.to_lowercase().as_str(),
            "dev" | "local" | "test"
        )
    }
}
