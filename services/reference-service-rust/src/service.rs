//! Item use cases. Depends on the `ItemRepository` port, never a concrete adapter.

use std::sync::Arc;

use keel_core::domain::errors::{DomainError, ErrorCategory};
use uuid::Uuid;

use crate::domain::{Item, ItemRepository};

/// Application service for the items aggregate.
pub struct ItemService {
    repo: Arc<dyn ItemRepository>,
}

impl ItemService {
    /// Build the service over a repository implementation.
    #[must_use]
    pub fn new(repo: Arc<dyn ItemRepository>) -> Self {
        Self { repo }
    }

    /// Create an item with a generated id.
    ///
    /// # Errors
    /// Propagates a repository [`DomainError`].
    pub async fn create(&self, name: &str) -> Result<Item, DomainError> {
        let item = Item {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
        };
        self.repo.add(&item).await?;
        Ok(item)
    }

    /// Fetch an item by id.
    ///
    /// # Errors
    /// `NotFound` if no item has that id; otherwise a repository error.
    pub async fn get(&self, id: &str) -> Result<Item, DomainError> {
        self.repo
            .get(id)
            .await?
            .ok_or_else(|| DomainError::new(ErrorCategory::NotFound, "item not found"))
    }

    /// List a page of items.
    ///
    /// # Errors
    /// Propagates a repository [`DomainError`].
    pub async fn list(&self, limit: i64, offset: i64) -> Result<Vec<Item>, DomainError> {
        self.repo.list(limit, offset).await
    }
}
