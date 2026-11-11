//! @< aggregate_pascal >@ use cases. Depends on the `@< aggregate_pascal >@Repository` port, never a concrete adapter.

use std::sync::Arc;

use keel_core::domain::errors::{DomainError, ErrorCategory};
use uuid::Uuid;

use crate::domain::{@< aggregate_pascal >@, @< aggregate_pascal >@Repository};

/// Application service for the @< aggregate_plural >@ aggregate.
pub struct @< aggregate_pascal >@Service {
    repo: Arc<dyn @< aggregate_pascal >@Repository>,
}

impl @< aggregate_pascal >@Service {
    /// Build the service over a repository implementation.
    #[must_use]
    pub fn new(repo: Arc<dyn @< aggregate_pascal >@Repository>) -> Self {
        Self { repo }
    }

    /// Create an @< aggregate >@ with a generated id.
    ///
    /// # Errors
    /// Propagates a repository [`DomainError`].
    pub async fn create(&self, name: &str) -> Result<@< aggregate_pascal >@, DomainError> {
        let @< aggregate >@ = @< aggregate_pascal >@ {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
        };
        self.repo.add(&@< aggregate >@).await?;
        Ok(@< aggregate >@)
    }

    /// Fetch an @< aggregate >@ by id.
    ///
    /// # Errors
    /// `NotFound` if no @< aggregate >@ has that id; otherwise a repository error.
    pub async fn get(&self, id: &str) -> Result<@< aggregate_pascal >@, DomainError> {
        self.repo
            .get(id)
            .await?
            .ok_or_else(|| DomainError::new(ErrorCategory::NotFound, "@< aggregate >@ not found"))
    }

    /// List a page of @< aggregate_plural >@.
    ///
    /// # Errors
    /// Propagates a repository [`DomainError`].
    pub async fn list(&self, limit: i64, offset: i64) -> Result<Vec<@< aggregate_pascal >@>, DomainError> {
        self.repo.list(limit, offset).await
    }
}
