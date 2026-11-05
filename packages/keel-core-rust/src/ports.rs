//! Driven ports: the interfaces the application depends on, implemented by adapters
//! (ADR-0002, ADR-0009). Keeping them as traits is what makes the hexagon swappable
//! and testable: the test kit ships a fake for each.

use std::time::SystemTime;

pub use crate::auth::{Authenticator, Principal};

/// Injectable time source, for testability (no direct `SystemTime::now()` in logic).
pub trait Clock: Send + Sync {
    /// The current instant.
    fn now(&self) -> SystemTime;
}

/// Reads secrets by key from a backing store (env, a vault, etc.).
pub trait SecretProvider: Send + Sync {
    /// Return the secret for `key`, or `None` if absent.
    fn get(&self, key: &str) -> Option<String>;
}
