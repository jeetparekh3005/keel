// OpenTelemetry wiring (platform.yaml telemetry): a shared resource (service identity) and
// OTLP trace export. Export is enabled only when an OTLP endpoint is configured; otherwise
// spans are no-ops. Log-to-trace correlation lives in ../logging (the pino mixin stamps
// trace_id/span_id), so a configured logger correlates regardless of whether export is on.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
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
 * Start OpenTelemetry tracing when an OTLP endpoint is configured, and return a shutdown
 * function to flush spans at exit. A no-op (returning an inert shutdown) when export is off.
 * Call once at startup, before the app handles traffic.
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
  });
  sdk.start();

  return async () => {
    await sdk.shutdown();
  };
}
