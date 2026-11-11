// OpenTelemetry wiring (platform.yaml telemetry): a shared resource (service identity), HTTP
// server instrumentation (so every request runs inside a span), and optional OTLP trace
// export. The instrumentation is always registered, so log-to-trace correlation works whether
// or not export is on: the pino mixin in ../logging reads the active span's trace_id/span_id.
// Export (an OTLP exporter + batch processor) is added only when an endpoint is configured.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
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
 * Start OpenTelemetry tracing when an OTLP endpoint is configured: register HTTP server
 * instrumentation (so every request runs inside a span) and the OTLP exporter. The
 * instrumentation is the piece that makes log-to-trace correlation actually produce output -
 * the pino mixin in ../logging reads the active span the instrumentation creates. Returns a
 * shutdown function to flush and tear down at exit; a no-op when no endpoint is configured
 * (tracing off, so logs carry no trace fields). Call once at startup, before serving traffic.
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
    instrumentations: [new HttpInstrumentation()],
    traceExporter: new OTLPTraceExporter({ url: options.otlpEndpoint }),
  });
  sdk.start();

  return async () => {
    await sdk.shutdown();
  };
}
