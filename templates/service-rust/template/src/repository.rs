//! SQL adapter implementing the `@< aggregate_pascal >@Repository` port (the driven side).
//! Maps rows to the domain `@< aggregate_pascal >@`; the sqlx pool never leaks past this module.

use async_trait::async_trait;
use keel_core::domain::errors::{DomainError, ErrorCategory};
use keel_core::persistence::Database;
use sqlx::{AnyPool, Row};

use crate::domain::{@< aggregate_pascal >@, @< aggregate_pascal >@Repository};

/// A Postgres-backed @< aggregate >@ repository (uses the keel-core connection pool).
pub struct Sql@< aggregate_pascal >@Repository {
    pool: AnyPool,
}

impl Sql@< aggregate_pascal >@Repository {
    /// Build the repository over the shared database pool.
    #[must_use]
    pub fn new(database: &Database) -> Self {
        Self {
            pool: database.pool().clone(),
        }
    }

    /// Create the @< aggregate_plural >@ table if it does not exist (dev convenience; production uses
    /// migrations).
    ///
    /// # Errors
    /// Returns an `Unavailable` [`DomainError`] on a database error.
    pub async fn ensure_schema(&self) -> Result<(), DomainError> {
        sqlx::query("CREATE TABLE IF NOT EXISTS @< aggregate_plural >@ (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
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
impl @< aggregate_pascal >@Repository for Sql@< aggregate_pascal >@Repository {
    async fn add(&self, @< aggregate >@: &@< aggregate_pascal >@) -> Result<(), DomainError> {
        sqlx::query("INSERT INTO @< aggregate_plural >@ (id, name) VALUES ($1, $2)")
            .bind(&@< aggregate >@.id)
            .bind(&@< aggregate >@.name)
            .execute(&self.pool)
            .await
            .map_err(db_error)?;
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<@< aggregate_pascal >@>, DomainError> {
        let row = sqlx::query("SELECT id, name FROM @< aggregate_plural >@ WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_error)?;
        Ok(row.map(|row| @< aggregate_pascal >@ {
            id: row.get("id"),
            name: row.get("name"),
        }))
    }

    async fn list(&self, limit: i64, offset: i64) -> Result<Vec<@< aggregate_pascal >@>, DomainError> {
        let rows = sqlx::query("SELECT id, name FROM @< aggregate_plural >@ ORDER BY id LIMIT $1 OFFSET $2")
            .bind(limit)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;
        Ok(rows
            .iter()
            .map(|row| @< aggregate_pascal >@ {
                id: row.get("id"),
                name: row.get("name"),
            })
            .collect())
    }
}
