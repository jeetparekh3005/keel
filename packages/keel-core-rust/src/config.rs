//! Typed configuration loading (platform.yaml config: typed, 12-factor, fail-fast).
//!
//! Layers an optional TOML file then `KEEL_`-prefixed environment variables (env
//! wins) and deserializes into the caller's typed struct. Invalid or missing
//! required config fails fast with a [`DomainError`]. Built-in defaults come from
//! the struct's serde field defaults; a secret-provider layer lands in a later slice.

use figment::providers::{Env, Format, Toml};
use figment::Figment;
use serde::de::DeserializeOwned;

use crate::domain::errors::{DomainError, ErrorCategory};

/// Load typed config from an optional TOML file plus `KEEL_`-prefixed env vars.
///
/// # Errors
/// Returns a [`DomainError`] in the `Internal` category if the merged configuration
/// does not deserialize into `T` (missing required field, wrong type, bad file).
pub fn load<T: DeserializeOwned>(config_file: Option<&str>) -> Result<T, DomainError> {
    let mut figment = Figment::new();
    if let Some(path) = config_file {
        figment = figment.merge(Toml::file(path));
    }
    figment
        .merge(Env::prefixed("KEEL_"))
        .extract()
        .map_err(|error| {
            DomainError::new(ErrorCategory::Internal, format!("invalid config: {error}"))
        })
}

#[cfg(test)]
mod tests {
    use super::load;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct Cfg {
        service_name: String,
        #[serde(default)]
        log_level: String,
    }

    #[test]
    fn loads_typed_config_from_prefixed_env() {
        figment::Jail::expect_with(|jail| {
            jail.set_env("KEEL_SERVICE_NAME", "ref");
            jail.set_env("KEEL_LOG_LEVEL", "debug");
            let cfg: Cfg = load(None).expect("config should load");
            assert_eq!(cfg.service_name, "ref");
            assert_eq!(cfg.log_level, "debug");
            Ok(())
        });
    }

    #[test]
    fn missing_required_field_fails_fast() {
        figment::Jail::expect_with(|jail| {
            jail.clear_env();
            assert!(load::<Cfg>(None).is_err());
            Ok(())
        });
    }
}
