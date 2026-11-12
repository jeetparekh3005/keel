// Command << service_name >> is the Go reference service entrypoint: load config, wire real
// adapters (Postgres + OIDC/JWKS), serve the composed app, and shut down gracefully.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.opentelemetry.io/otel"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/persistence"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/telemetry"
	"github.com/jeetparekh3005/keel/services/<< service_slug >>/app"
)

func main() {
	if err := run(); err != nil {
		slog.Error("<< service_name >> exited with error", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := app.LoadConfig()
	if err != nil {
		return err
	}

	// SIGTERM (rolling deploy) / SIGINT (local) cancels this context to start shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	shutdownTelemetry, err := telemetry.Init(ctx, cfg.ServiceName, cfg.Version, cfg.Environment, cfg.LogLevel, cfg.OTLPEndpoint)
	if err != nil {
		return err
	}

	db, err := persistence.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()

	// Emit DB pool saturation gauges (the fourth golden signal) against the installed
	// MeterProvider; the callback reads live pool stats on each collection.
	if err := db.ObservePoolMetrics(otel.GetMeterProvider(), "default"); err != nil {
		return err
	}

	repo := app.NewSql<< aggregate_pascal >>Repository(db)
	if err := repo.EnsureSchema(ctx); err != nil {
		return err
	}

	// Verify tokens against the issuer's JWKS; go-oidc refreshes the key set on rotation.
	authenticator := auth.NewOIDCAuthenticator(ctx, cfg.OIDCIssuer, cfg.OIDCAudience, cfg.OIDCJwksURI)

	handler := app.BuildApp(repo, func(c context.Context) bool { return db.Ping(c) }, authenticator, httpx.AppConfig{
		CORSAllowOrigins: cfg.CORSAllowOrigins,
	})
	server := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%d", cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		slog.Info("<< service_name >> listening", "addr", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
		slog.Info("shutdown signal received; draining in-flight requests")
	}

	// Drain in-flight requests, then flush telemetry.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("graceful shutdown failed", "error", err)
	}
	if err := shutdownTelemetry(shutdownCtx); err != nil {
		slog.Error("telemetry shutdown failed", "error", err)
	}
	return nil
}
