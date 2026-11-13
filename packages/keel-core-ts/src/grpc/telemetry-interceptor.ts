import { type Interceptor } from '@connectrpc/connect';
import { context as otelContext, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Build the OpenTelemetry server interceptor for gRPC, matching the Python factory's
 * `aio_server_interceptor`. It starts a SERVER span per call, makes it the active span for the
 * whole handler (so logs emitted while handling carry trace_id/span_id, as the pino mixin reads
 * the active span), records an error status if the call throws, and ends the span. The span is a
 * no-op when tracing is not configured (the global tracer provider is the API's no-op), so this
 * is safe to install unconditionally.
 */
export function createTelemetryInterceptor(): Interceptor {
  const tracer = trace.getTracer('@keel/core');
  return (next) => async (req) => {
    const span = tracer.startSpan(`grpc ${req.service.typeName}/${req.method.name}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'rpc.system': 'grpc',
        'rpc.service': req.service.typeName,
        'rpc.method': req.method.name,
      },
    });
    const active = trace.setSpan(otelContext.active(), span);
    try {
      return await otelContext.with(active, () => next(req));
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  };
}
