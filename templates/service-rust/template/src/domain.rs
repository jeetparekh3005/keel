//! @< aggregate_pascal_plural >@ domain: the aggregate and its repository port (service-defined per ADR-0009).
//! Pure: no SQL, no HTTP.

use async_trait::async_trait;
use keel_core::domain::errors::DomainError;

/// An @< aggregate >@ aggregate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct @< aggregate_pascal >@ {
    pub id: String,
    pub name: String,
}

/// The driven port for @< aggregate >@ persistence (one per aggregate). Adapters implement it;
/// the ORM/driver never crosses this boundary.
#[async_trait]
pub trait @< aggregate_pascal >@Repository: Send + Sync {
    /// Persist a new @< aggregate >@.
    async fn add(&self, @< aggregate >@: &@< aggregate_pascal >@) -> Result<(), DomainError>;
    /// Fetch an @< aggregate >@ by id, or `None` if absent.
    async fn get(&self, id: &str) -> Result<Option<@< aggregate_pascal >@>, DomainError>;
    /// List @< aggregate_plural >@ with limit/offset pagination, ordered by id.
    async fn list(&self, limit: i64, offset: i64) -> Result<Vec<@< aggregate_pascal >@>, DomainError>;
}
