package persistence

import (
	"context"
	"os"
	"testing"
	"time"

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
