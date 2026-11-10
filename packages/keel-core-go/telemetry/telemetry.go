// Package telemetry wires OpenTelemetry (platform.yaml telemetry): a shared resource
// (service identity), OTLP trace export, and the redacting JSON logger with trace
// correlation. Export is enabled only when an OTLP endpoint is configured; otherwise logs
// still emit and spans are no-ops.
package telemetry

import (
	"context"
	"log/slog"
	"os"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/logging"
)

// Resource builds the shared telemetry resource: service name/version, deployment
// environment, and a per-instance id so replicas are distinguishable in traces.
func Resource(ctx context.Context, service, version, environment string) (*resource.Resource, error) {
	return resource.New(ctx, resource.WithAttributes(
		attribute.String("service.name", service),
		attribute.String("service.version", version),
		attribute.String("deployment.environment.name", environment),
		attribute.String("service.instance.id", uuid.NewString()),
	))
}

// Init installs the global slog logger (redacting JSON + trace correlation) and, when
// otlpEndpoint is non-empty, an OTLP trace exporter and TracerProvider. It returns a
// shutdown func to call at exit (flushes spans); the func is a no-op when export is off.
func Init(ctx context.Context, service, version, environment, level, otlpEndpoint string) (func(context.Context) error, error) {
	base := logging.NewHandler(level, os.Stdout)
	slog.SetDefault(slog.New(correlatingHandler{inner: base}))

	noop := func(context.Context) error { return nil }
	if otlpEndpoint == "" {
		return noop, nil
	}

	res, err := Resource(ctx, service, version, environment)
	if err != nil {
		return noop, err
	}
	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(otlpEndpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return noop, err
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithBatcher(exporter),
	)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return provider.Shutdown, nil
}
