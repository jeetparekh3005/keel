import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { context as otelContext, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { IncomingMessage } from 'node:http';
import { Observable } from 'rxjs';

import { routeTemplate } from './route-template.js';

/**
 * Starts a server span per request and makes it the active span for the whole handler, so logs
 * emitted during the request carry trace_id/span_id (the pino mixin reads the active span).
 *
 * This is deliberately an interceptor rather than @opentelemetry/instrumentation-http: the HTTP
 * instrumentation only patches Node's `http` if it is registered before `http` is loaded, which
 * a plain `node dist/main.js` entrypoint cannot guarantee (NestJS loads `http` at import time,
 * before telemetry init) - so that approach silently produced no correlation. The interceptor
 * uses the OpenTelemetry API at request time and is independent of module load order. The span
 * is a no-op (so no trace fields are emitted) when tracing is not configured.
 */
@Injectable()
export class TracingInterceptor implements NestInterceptor {
  private readonly tracer = trace.getTracer('@keel/core');

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = executionContext.switchToHttp().getRequest<IncomingMessage>();
    // Name the span by the route TEMPLATE (e.g. `GET /v1/items/:id`), not the raw URL: the url
    // carries per-request id values that fragment traces and blow up span-name cardinality.
    const route = routeTemplate(executionContext);
    const span = this.tracer.startSpan(`${request.method ?? 'HTTP'} ${route}`.trim(), {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': request.method,
        'http.route': route,
        'url.path': request.url,
      },
    });
    const activeContext = trace.setSpan(otelContext.active(), span);

    return new Observable((subscriber) => {
      // Run the handler subscription inside the span's context so the async handler (and its
      // logs) see it as the active span.
      otelContext.with(activeContext, () => {
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err) => {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            subscriber.error(err);
          },
          complete: () => {
            span.end();
            subscriber.complete();
          },
        });
      });
    });
  }
}
