//! Items domain: the aggregate and its repository port (service-defined per ADR-0009).
//! Pure: no SQL, no HTTP.

use async_trait::async_trait;
use keel_core::domain::errors::DomainError;

/// An item aggregate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub name: String,
}

/// The driven port for item persistence (one per aggregate). Adapters implement it;
/// the ORM/driver never crosses this boundary.
#[async_trait]
pub trait ItemRepository: Send + Sync {
    /// Persist a new item.
    async fn add(&self, item: &Item) -> Result<(), DomainError>;
    /// Fetch an item by id, or `None` if absent.
    async fn get(&self, id: &str) -> Result<Option<Item>, DomainError>;
    /// List items with limit/offset pagination, ordered by id.
    async fn list(&self, limit: i64, offset: i64) -> Result<Vec<Item>, DomainError>;
}
