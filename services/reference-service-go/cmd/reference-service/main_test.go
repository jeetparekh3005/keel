package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jeetparekh3005/keel/services/reference-service-go/app"
)

// freePort reserves and releases a loopback port, returning its number. A brief TOCTOU window
// remains before run() rebinds it, which is acceptable for a local/CI smoke test.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

// TestRunServesThenShutsDownGracefully boots the whole service via run() against a real Postgres
// (telemetry init, pool connect, schema, OIDC authenticator construction, the composed router,
// and a live listener), asserts the health and readiness probes answer, then cancels the context
// and asserts run() drains and returns nil. This is the entrypoint's only end-to-end wiring test:
// it proves the real adapters compose and the SIGTERM/SIGINT shutdown path is clean.
func TestRunServesThenShutsDownGracefully(t *testing.T) {
	dbURL := os.Getenv("KEEL_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("KEEL_TEST_DATABASE_URL not set; skipping run() boot/shutdown integration test")
	}

	port := freePort(t)
	t.Setenv("KEEL_DATABASE_URL", dbURL)
	t.Setenv("KEEL_PORT", fmt.Sprintf("%d", port))
	// Export is off (no OTLP endpoint) so telemetry.Init installs no-op providers and the
	// shutdown func is a no-op; the test still exercises the init/shutdown call sites.
	t.Setenv("KEEL_OTLP_ENDPOINT", "")

	cfg, err := app.LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { errc <- run(ctx, cfg) }()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{Timeout: time.Second}
	deadline := time.After(15 * time.Second)
	ready := false
	for !ready {
		select {
		case err := <-errc:
			t.Fatalf("run returned before serving: %v", err)
		case <-deadline:
			t.Fatal("service did not become ready within 15s")
		default:
		}
		resp, err := client.Get(base + "/readyz")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				ready = true
			}
		}
		if !ready {
			time.Sleep(100 * time.Millisecond)
		}
	}

	// Liveness is always 200 once the server is up.
	resp, err := client.Get(base + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/healthz = %d, want 200", resp.StatusCode)
	}

	// Cancelling the context is the in-process equivalent of SIGTERM: run() must drain and
	// return nil, not hang or error.
	cancel()
	select {
	case err := <-errc:
		if err != nil {
			t.Fatalf("run() returned %v on graceful shutdown, want nil", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("run() did not shut down within 20s of context cancellation")
	}
}
