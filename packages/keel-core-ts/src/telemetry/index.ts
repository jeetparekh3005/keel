// OpenTelemetry wiring (platform.yaml telemetry): when an OTLP endpoint is configured, start
// the SDK (tracer provider + meter provider + async-context manager + OTLP exporters). Spans are
// created per request by the TracingInterceptor (../http) and HTTP request metrics by the
// MetricsInterceptor (../http), both independent of module load order; the pino mixin
// (../logging) reads the active span to stamp trace_id/span_id. Tracing, metrics, and export are
// gated on the endpoint: with none configured this is a no-op (logs carry no trace fields and the
// global meter provider is the API's no-op, so interceptor instruments record nothing).
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { randomUUID } from 'node:crypto';

/** Telemetry identity and export configuration. */
export interface TelemetryOptions {
  serviceName: string;
  version: string;
  environment: string;
  /** OTLP gRPC endpoint (e.g. http://collector:4317). Export is off when empty. */
  otlpEndpoint?: string;
}

/**
 * Start OpenTelemetry when an OTLP endpoint is configured: NodeSDK registers the tracer
 * provider, a meter provider (a PeriodicExportingMetricReader draining an OTLP metric exporter),
 * and the async-context manager (so the TracingInterceptor's per-request span propagates to the
 * async handler and its logs). Registering the meter provider globally is what lets the
 * MetricsInterceptor's instruments (`http.server.*`) reach a real sink. Returns a shutdown
 * function to flush and tear down at exit; a no-op when no endpoint is configured (tracing and
 * metrics off). Call once at startup, before serving traffic.
 */
export function initTelemetry(options: TelemetryOptions): () => Promise<void> {
  if (!options.otlpEndpoint) {
    return async () => {};
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]: options.version,
    'deployment.environment.name': options.environment,
    'service.instance.id': randomUUID(),
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: options.otlpEndpoint }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: options.otlpEndpoint }),
      }),
    ],
  });
  sdk.start();

  return async () => {
    await sdk.shutdown();
  };
}
