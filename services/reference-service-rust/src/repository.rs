//! SQL adapter implementing the `ItemRepository` port (the driven side).
//! Maps rows to the domain `Item`; the sqlx pool never leaks past this module.

use async_trait::async_trait;
use keel_core::domain::errors::{DomainError, ErrorCategory};
use keel_core::persistence::Database;
use sqlx::{AnyPool, Row};

use crate::domain::{Item, ItemRepository};

/// A Postgres-backed item repository (uses the keel-core connection pool).
pub struct SqlItemRepository {
    pool: AnyPool,
}

impl SqlItemRepository {
    /// Build the repository over the shared database pool.
    #[must_use]
    pub fn new(database: &Database) -> Self {
        Self {
            pool: database.pool().clone(),
        }
    }

    /// Create the items table if it does not exist (dev convenience; production uses
    /// migrations).
    ///
    /// # Errors
    /// Returns an `Unavailable` [`DomainError`] on a database error.
    pub async fn ensure_schema(&self) -> Result<(), DomainError> {
        sqlx::query("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&self.pool)
            .await
            .map_err(db_error)?;
        Ok(())
    }
}

fn db_error(error: sqlx::Error) -> DomainError {
    DomainError::new(ErrorCategory::Unavailable, format!("database: {error}"))
}

#[async_trait]
impl ItemRepository for SqlItemRepository {
    async fn add(&self, item: &Item) -> Result<(), DomainError> {
        sqlx::query("INSERT INTO items (id, name) VALUES ($1, $2)")
            .bind(&item.id)
            .bind(&item.name)
            .execute(&self.pool)
            .await
            .map_err(db_error)?;
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<Item>, DomainError> {
        let row = sqlx::query("SELECT id, name FROM items WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_error)?;
        Ok(row.map(|row| Item {
            id: row.get("id"),
            name: row.get("name"),
        }))
    }

    async fn list(&self, limit: i64, offset: i64) -> Result<Vec<Item>, DomainError> {
        let rows = sqlx::query("SELECT id, name FROM items ORDER BY id LIMIT $1 OFFSET $2")
            .bind(limit)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;
        Ok(rows
            .iter()
            .map(|row| Item {
                id: row.get("id"),
                name: row.get("name"),
            })
            .collect())
    }
}
