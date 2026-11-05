//! Persistence plumbing (platform.yaml persistence): a `Database` connection pool
//! and a `UnitOfWork` transaction boundary.
//!
//! keel-core ships the plumbing, not a generic repository: each service defines its
//! own repository trait per aggregate and maps rows to domain types (ADR-0009). The
//! pool uses sqlx's `Any` driver so the same code runs on Postgres in production and
//! SQLite in tests (platform.yaml persistence.swappable). Commit is explicit; a
//! `UnitOfWork` dropped without `commit` rolls back - so a read-only block is a clean
//! rollback and a write is only persisted by an explicit commit (no silent-skip bug).

use sqlx::any::{install_default_drivers, AnyPoolOptions};
use sqlx::{Any, AnyConnection, AnyPool};

use crate::domain::errors::{DomainError, ErrorCategory};

/// Connection-pool usage, for the saturation (fourth golden) signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolStats {
    /// Connections currently open (in use plus idle).
    pub size: u32,
    /// Connections open and idle (not checked out).
    pub idle: u32,
}

/// A database connection pool over sqlx's `Any` backend.
///
/// Cloning is cheap: the inner `AnyPool` is an `Arc`-backed handle to the same pool,
/// so clones share connections (used e.g. to capture the pool in a readiness check).
#[derive(Clone)]
pub struct Database {
    pool: AnyPool,
}

impl Database {
    /// Connect to `url` (e.g. `postgres://...` or `sqlite::memory:`) and build a pool.
    ///
    /// # Errors
    /// Returns an `Unavailable` [`DomainError`] if the pool cannot be established.
    pub async fn connect(url: &str) -> Result<Self, DomainError> {
        Self::connect_with(url, 10).await
    }

    /// Connect with an explicit maximum pool size.
    ///
    /// # Errors
    /// Returns an `Unavailable` [`DomainError`] if the pool cannot be established.
    pub async fn connect_with(url: &str, max_connections: u32) -> Result<Self, DomainError> {
        install_default_drivers();
        let pool = AnyPoolOptions::new()
            .max_connections(max_connections)
            .connect(url)
            .await
            .map_err(|error| {
                DomainError::new(
                    ErrorCategory::Unavailable,
                    format!("database connect: {error}"),
                )
            })?;
        Ok(Self { pool })
    }

    /// The underlying pool, for executing queries outside a unit of work.
    #[must_use]
    pub fn pool(&self) -> &AnyPool {
        &self.pool
    }

    /// Readiness: true if a trivial query succeeds within the datasource.
    pub async fn ping(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.pool).await.is_ok()
    }

    /// Current pool usage for the saturation gauge.
    #[must_use]
    pub fn pool_stats(&self) -> PoolStats {
        PoolStats {
            size: self.pool.size(),
            idle: u32::try_from(self.pool.num_idle()).unwrap_or(u32::MAX),
        }
    }

    /// Begin a transactional unit of work.
    ///
    /// # Errors
    /// Returns an `Unavailable` [`DomainError`] if a transaction cannot be started.
    pub async fn begin(&self) -> Result<UnitOfWork, DomainError> {
        let tx = self.pool.begin().await.map_err(|error| {
            DomainError::new(
                ErrorCategory::Unavailable,
                format!("begin transaction: {error}"),
            )
        })?;
        Ok(UnitOfWork { tx })
    }
}

/// A transaction boundary. Execute queries against [`UnitOfWork::tx`]; call
/// [`UnitOfWork::commit`] to persist. Dropping without committing rolls back.
pub struct UnitOfWork {
    tx: sqlx::Transaction<'static, Any>,
}

impl UnitOfWork {
    /// The transaction's connection, to execute queries against (sqlx `Executor`).
    pub fn tx(&mut self) -> &mut AnyConnection {
        &mut self.tx
    }

    /// Commit the transaction, persisting all writes.
    ///
    /// # Errors
    /// Returns an `Internal` [`DomainError`] if the commit fails.
    pub async fn commit(self) -> Result<(), DomainError> {
        self.tx
            .commit()
            .await
            .map_err(|error| DomainError::new(ErrorCategory::Internal, format!("commit: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::Database;

    // Each test gets its own shared-cache in-memory SQLite DB (unique name) so the
    // pooled connections share one DB within a test but tests stay isolated in parallel.
    async fn setup(db_name: &str) -> Database {
        let url = format!("sqlite:file:{db_name}?mode=memory&cache=shared");
        let db = Database::connect(&url).await.expect("connect");
        sqlx::query("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(db.pool())
            .await
            .expect("create table");
        db
    }

    async fn count(db: &Database) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM t")
            .fetch_one(db.pool())
            .await
            .expect("count")
    }

    #[tokio::test]
    async fn ping_succeeds() {
        assert!(setup("ping_db").await.ping().await);
    }

    #[tokio::test]
    async fn commit_persists_the_write() {
        let db = setup("commit_db").await;
        let mut uow = db.begin().await.unwrap();
        sqlx::query("INSERT INTO t (id, name) VALUES (1, 'committed')")
            .execute(uow.tx())
            .await
            .unwrap();
        uow.commit().await.unwrap();
        assert_eq!(count(&db).await, 1);
    }

    #[tokio::test]
    async fn dropping_without_commit_rolls_back() {
        let db = setup("rollback_db").await;
        {
            let mut uow = db.begin().await.unwrap();
            sqlx::query("INSERT INTO t (id, name) VALUES (2, 'rolled-back')")
                .execute(uow.tx())
                .await
                .unwrap();
            // no commit: dropping uow here must roll back.
        }
        assert_eq!(count(&db).await, 0);
    }
}
