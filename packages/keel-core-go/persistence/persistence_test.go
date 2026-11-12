package persistence

import (
	"context"
	"os"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

func TestConnectFailsWithUnavailableDomainError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// Port 1 is not a Postgres server, so connect/ping fails.
	_, err := Connect(ctx, "postgres://keel@127.0.0.1:1/nodb")
	if err == nil {
		t.Fatal("expected a connection error")
	}
	de, ok := err.(*domain.DomainError)
	if !ok || de.Category != domain.Unavailable {
		t.Fatalf("want Unavailable DomainError, got %v", err)
	}
}

// TestPoolMetricsEmitSaturationGauges registers the pool saturation gauges against a fake stats
// source, forces a Collect, and asserts the OTel DB semconv signals are present:
// db.client.connection.count by state {used, idle} and db.client.connection.max, each carrying
// the pool name. Removing the gauge registration in observePoolMetrics makes this fail: no
// instruments observe, so neither metric appears in the collected data.
func TestPoolMetricsEmitSaturationGauges(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))

	// Fake stats: 7 used (acquired), 3 idle, ceiling of 10. A live pool is not needed.
	stats := func() PoolStats {
		return PoolStats{Total: 10, Idle: 3, Acquired: 7, Max: 10}
	}
	if err := observePoolMetrics(mp, "default", stats); err != nil {
		t.Fatalf("register pool metrics: %v", err)
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatalf("collect: %v", err)
	}

	count := findPoolMetric(t, &rm, "db.client.connection.count")
	gauge, ok := count.Data.(metricdata.Gauge[int64])
	if !ok {
		t.Fatalf("count is %T, want Gauge[int64]", count.Data)
	}
	byState := map[string]int64{}
	for _, dp := range gauge.DataPoints {
		if pool := poolAttr(dp.Attributes, "db.client.connection.pool.name"); pool != "default" {
			t.Errorf("count pool.name = %q, want default", pool)
		}
		byState[poolAttr(dp.Attributes, "db.client.connection.state")] = dp.Value
	}
	if byState["used"] != 7 {
		t.Errorf("count state=used = %d, want 7", byState["used"])
	}
	if byState["idle"] != 3 {
		t.Errorf("count state=idle = %d, want 3", byState["idle"])
	}
	if _, ok := byState["used"]; !ok {
		t.Error("count missing state=used series")
	}
	if _, ok := byState["idle"]; !ok {
		t.Error("count missing state=idle series")
	}

	max := findPoolMetric(t, &rm, "db.client.connection.max")
	maxGauge, ok := max.Data.(metricdata.Gauge[int64])
	if !ok {
		t.Fatalf("max is %T, want Gauge[int64]", max.Data)
	}
	if len(maxGauge.DataPoints) != 1 {
		t.Fatalf("max data points = %d, want 1", len(maxGauge.DataPoints))
	}
	if v := maxGauge.DataPoints[0].Value; v != 10 {
		t.Errorf("max value = %d, want 10", v)
	}
	if pool := poolAttr(maxGauge.DataPoints[0].Attributes, "db.client.connection.pool.name"); pool != "default" {
		t.Errorf("max pool.name = %q, want default", pool)
	}
}

func findPoolMetric(t *testing.T, rm *metricdata.ResourceMetrics, name string) metricdata.Metrics {
	t.Helper()
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name == name {
				return m
			}
		}
	}
	t.Fatalf("metric %q not recorded (is the pool metric registration wired?)", name)
	return metricdata.Metrics{}
}

func poolAttr(set attribute.Set, key string) string {
	v, ok := set.Value(attribute.Key(key))
	if !ok {
		return ""
	}
	return v.AsString()
}

// Integration: runs only when KEEL_TEST_DATABASE_URL is set (Go's t.Skip reports it as
// skipped, not passed). When set but unreachable it fails loudly rather than silently.
func TestUnitOfWorkCommitPersistsAndRollbackDiscards(t *testing.T) {
	url := os.Getenv("KEEL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("KEEL_TEST_DATABASE_URL not set; skipping Postgres integration test")
	}
	ctx := context.Background()
	db, err := Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer db.Close()

	if _, err := db.Pool().Exec(ctx, `CREATE TABLE IF NOT EXISTS uow_test (id text PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `DELETE FROM uow_test`); err != nil {
		t.Fatal(err)
	}

	// Commit path: the row persists.
	uow, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := uow.Tx().Exec(ctx, `INSERT INTO uow_test (id) VALUES ($1)`, "committed"); err != nil {
		t.Fatal(err)
	}
	if err := uow.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// Rollback path: a unit of work that is not committed leaves nothing behind.
	uow2, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := uow2.Tx().Exec(ctx, `INSERT INTO uow_test (id) VALUES ($1)`, "discarded"); err != nil {
		t.Fatal(err)
	}
	uow2.Rollback(ctx) // no commit

	var count int
	if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM uow_test`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("row count = %d, want 1 (commit persisted, rollback discarded)", count)
	}
}
