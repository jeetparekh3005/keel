//! Reference-service configuration (KEEL_-prefixed env, loaded via keel-core).

use keel_core::domain::errors::DomainError;
use serde::Deserialize;

/// Typed service configuration. Secure by default: `environment` defaults to
/// `production`, so docs stay hidden and the JWKS endpoint must be https unless an
/// explicit dev environment opts in.
#[derive(Debug, Clone, Deserialize)]
pub struct ReferenceConfig {
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
}

fn default_service_name() -> String {
    "reference-service".to_string()
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

impl ReferenceConfig {
    /// Load from `KEEL_`-prefixed environment variables (fail-fast on missing OIDC).
    ///
    /// # Errors
    /// Returns a [`DomainError`] if required config is missing or malformed.
    pub fn from_env() -> Result<Self, DomainError> {
        keel_core::config::load(None)
    }

    /// True in a dev-like environment (relaxes docs exposure and https-JWKS).
    #[must_use]
    pub fn is_dev_like(&self) -> bool {
        matches!(
            self.environment.to_lowercase().as_str(),
            "dev" | "local" | "test"
        )
    }
}
