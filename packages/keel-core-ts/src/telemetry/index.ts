// OpenTelemetry wiring (platform.yaml telemetry): when an OTLP endpoint is configured, start
// the SDK (tracer provider + async-context manager + OTLP exporter). Spans are created per
// request by the TracingInterceptor (../http), which is independent of module load order; the
// pino mixin (../logging) reads the active span to stamp trace_id/span_id. Both tracing and
// export are gated on the endpoint: with none configured this is a no-op and logs carry no
// trace fields.
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
 * Start OpenTelemetry when an OTLP endpoint is configured: NodeSDK registers the tracer
 * provider, the async-context manager (so the TracingInterceptor's per-request span propagates
 * to the async handler and its logs), and the OTLP exporter. Returns a shutdown function to
 * flush and tear down at exit; a no-op when no endpoint is configured (tracing off, so logs
 * carry no trace fields). Call once at startup, before serving traffic.
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
