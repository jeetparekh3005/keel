// Package persistence is the database plumbing (platform.yaml persistence): a pgx
// connection pool as Database and a UnitOfWork transaction boundary. Like the other
// verticals it ships the plumbing, not a generic repository: each service defines its own
// repository per aggregate and maps rows to domain types (ADR-0009).
package persistence

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

// Database is a Postgres connection pool.
type Database struct {
	pool *pgxpool.Pool
}

// Connect opens a pool for url (postgres://...) and verifies connectivity (fail-fast).
func Connect(ctx context.Context, url string) (*Database, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, domain.New(domain.Unavailable, "database connect: "+err.Error())
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, domain.New(domain.Unavailable, "database ping: "+err.Error())
	}
	return &Database{pool: pool}, nil
}

// Pool returns the underlying pool, for executing queries outside a unit of work.
func (d *Database) Pool() *pgxpool.Pool { return d.pool }

// Ping reports readiness: true if a trivial round-trip to the datasource succeeds.
func (d *Database) Ping(ctx context.Context) bool { return d.pool.Ping(ctx) == nil }

// Close releases the pool.
func (d *Database) Close() { d.pool.Close() }

// PoolStats is pool usage, for the saturation (fourth golden) signal.
type PoolStats struct {
	Total    int32
	Idle     int32
	Acquired int32
}

// Stats returns current pool usage.
func (d *Database) Stats() PoolStats {
	s := d.pool.Stat()
	return PoolStats{Total: s.TotalConns(), Idle: s.IdleConns(), Acquired: s.AcquiredConns()}
}

// Begin starts a transactional unit of work.
func (d *Database) Begin(ctx context.Context) (*UnitOfWork, error) {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return nil, domain.New(domain.Unavailable, "begin transaction: "+err.Error())
	}
	return &UnitOfWork{tx: tx}, nil
}

// UnitOfWork is a transaction boundary. Commit is explicit; always `defer uow.Rollback(ctx)`
// immediately after Begin so a block that returns early (or errors) rolls back rather than
// silently persisting a partial write. Rollback after a Commit is a safe no-op.
type UnitOfWork struct {
	tx pgx.Tx
}

// Tx is the transaction handle the repository executes against.
func (u *UnitOfWork) Tx() pgx.Tx { return u.tx }

// Commit persists the unit of work.
func (u *UnitOfWork) Commit(ctx context.Context) error {
	if err := u.tx.Commit(ctx); err != nil {
		return domain.New(domain.Internal, "commit: "+err.Error())
	}
	return nil
}

// Rollback aborts the unit of work. It is safe to call after Commit (pgx returns
// ErrTxClosed, which is ignored), which is why it can always be deferred.
func (u *UnitOfWork) Rollback(ctx context.Context) {
	_ = u.tx.Rollback(ctx)
}
