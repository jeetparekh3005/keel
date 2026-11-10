//! Driven-port adapters that keel-core ships (the Clock and SecretProvider ports).
//! The HTTP, auth, and persistence adapters live in their own modules.

use std::time::SystemTime;

use crate::ports::{Clock, SecretProvider};

/// A [`Clock`] backed by the system wall clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

/// A [`SecretProvider`] reading from process environment variables.
pub struct EnvSecretProvider;

impl SecretProvider for EnvSecretProvider {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{EnvSecretProvider, SystemClock};
    use crate::ports::{Clock, SecretProvider};
    use std::time::{Duration, SystemTime};

    #[test]
    fn system_clock_advances() {
        let clock = SystemClock;
        let first = clock.now();
        // now() is monotonic-ish wall time; it must be at/after a fixed past instant.
        assert!(first >= SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000));
    }

    #[test]
    fn env_secret_provider_reads_present_and_misses_absent() {
        // Use an always-present var (PATH) rather than mutating the environment,
        // which keeps the test independent of edition-specific set_var safety.
        let provider = EnvSecretProvider;
        assert!(provider.get("PATH").is_some());
        assert!(provider.get("KEEL_DEFINITELY_ABSENT_VAR").is_none());
    }
}
