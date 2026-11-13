// Package persistence is the database plumbing (platform.yaml persistence): a pgx
// connection pool as Database and a UnitOfWork transaction boundary. Like the other
// verticals it ships the plumbing, not a generic repository: each service defines its own
// repository per aggregate and maps rows to domain types (ADR-0009).
package persistence

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

// meterName scopes the pool saturation instruments to this package so the emitted metrics are
// attributable to keel-core-go rather than an anonymous scope.
const meterName = "github.com/jeetparekh3005/keel/packages/keel-core-go/persistence"

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

// PoolStats is pool usage, for the saturation (fourth golden) signal. Max is the configured
// ceiling (the saturation denominator); Acquired/Idle/Total are the live counts.
type PoolStats struct {
	Total    int32
	Idle     int32
	Acquired int32
	Max      int32
}

// Stats returns current pool usage.
func (d *Database) Stats() PoolStats {
	s := d.pool.Stat()
	return PoolStats{
		Total:    s.TotalConns(),
		Idle:     s.IdleConns(),
		Acquired: s.AcquiredConns(),
		Max:      s.MaxConns(),
	}
}

// ObservePoolMetrics registers OpenTelemetry observable gauges of this pool's saturation on mp,
// reading the live pool stats on each metric collection. It emits the OTel DB semconv signals
// db.client.connection.count (by state: used | idle) and db.client.connection.max (the
// denominator), both tagged with db.client.connection.pool.name so a service running several
// pools does not collapse them into one series. Call it once after the pool is connected and the
// MeterProvider is installed. A no-op provider (telemetry export off) yields no-op instruments,
// so this is always safe to call.
func (d *Database) ObservePoolMetrics(mp metric.MeterProvider, poolName string) error {
	return observePoolMetrics(mp, poolName, d.Stats)
}

// observePoolMetrics is the decoupled core of ObservePoolMetrics: it reads whatever stats
// returns on each collection, so a test can register against a fake stats source without a live
// pool.
func observePoolMetrics(mp metric.MeterProvider, poolName string, stats func() PoolStats) error {
	m := mp.Meter(meterName)
	count, err := m.Int64ObservableGauge(
		"db.client.connection.count",
		metric.WithUnit("{connection}"),
		metric.WithDescription("Database connections by state."),
	)
	if err != nil {
		return err
	}
	maxConns, err := m.Int64ObservableGauge(
		"db.client.connection.max",
		metric.WithUnit("{connection}"),
		metric.WithDescription("Maximum open connections the pool allows (saturation denominator)."),
	)
	if err != nil {
		return err
	}
	pool := attribute.String("db.client.connection.pool.name", poolName)
	_, err = m.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		s := stats()
		// semconv state enum {used, idle}: used = checked-out connections, idle = warm
		// checked-in connections.
		o.ObserveInt64(count, int64(s.Acquired),
			metric.WithAttributes(pool, attribute.String("db.client.connection.state", "used")))
		o.ObserveInt64(count, int64(s.Idle),
			metric.WithAttributes(pool, attribute.String("db.client.connection.state", "idle")))
		o.ObserveInt64(maxConns, int64(s.Max), metric.WithAttributes(pool))
		return nil
	}, count, maxConns)
	return err
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
