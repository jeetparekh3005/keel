// Package telemetry wires OpenTelemetry (platform.yaml telemetry): a shared resource
// (service identity), OTLP trace and metric export, and the redacting JSON logger with
// trace correlation. Export is enabled only when an OTLP endpoint is configured; otherwise
// logs still emit and spans and metrics are no-ops.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"os"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
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
// otlpEndpoint is non-empty, OTLP exporters wired to a global TracerProvider and
// MeterProvider. It returns a shutdown func to call at exit (flushes spans and metrics);
// the func is a no-op when export is off. Metrics are exported via a periodic reader so the
// HTTP request instruments (http.server.request.duration, http.server.active_requests) reach
// the collector without any per-request flush.
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

	traceExporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(otlpEndpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return noop, err
	}
	// Wrap the OTLP exporter so span attributes are redacted on the export path with the same
	// rules as the log sink; otherwise a secret could leak to the collector via a trace.
	tracerProvider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithBatcher(newRedactingExporter(traceExporter)),
	)
	otel.SetTracerProvider(tracerProvider)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	metricExporter, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(otlpEndpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		// Trace export is already live; tear it down so the partial failure is clean.
		return noop, errors.Join(err, tracerProvider.Shutdown(ctx))
	}
	meterProvider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExporter)),
	)
	otel.SetMeterProvider(meterProvider)

	// Shut both providers down, joining errors so one failure does not mask the other.
	shutdown := func(ctx context.Context) error {
		return errors.Join(tracerProvider.Shutdown(ctx), meterProvider.Shutdown(ctx))
	}
	return shutdown, nil
}
