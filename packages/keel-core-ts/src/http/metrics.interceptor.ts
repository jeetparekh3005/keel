import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import {
  type Attributes,
  type Counter,
  type Histogram,
  metrics,
  ValueType,
} from '@opentelemetry/api';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Observable } from 'rxjs';

import { routeTemplate } from './route-template.js';

/**
 * Emits HTTP server request metrics (OpenTelemetry semantic conventions) for every routed
 * request: a duration histogram (`http.server.request.duration`, seconds) and an in-flight
 * up-down counter (`http.server.active_requests`). Like the TracingInterceptor, this uses the
 * OpenTelemetry API at request time rather than http instrumentation, so it is independent of
 * module load order and is a no-op (the API's default meter records nothing) until a meter
 * provider is registered by initTelemetry (../telemetry).
 *
 * The route label is the matched Nest route TEMPLATE (e.g. `/v1/items/:id`), read from the
 * controller + handler `path` metadata, NOT `request.url` - the raw URL carries per-id values
 * and would explode metric cardinality.
 *
 * active_requests increments on entry and decrements on response completion with the SAME
 * attribute set (route + method); omitting the status code is deliberate - it is unknown on
 * entry, and an up-down counter only nets back to zero when add(+1)/add(-1) share attributes.
 * The duration histogram additionally carries the final `http.response.status_code`.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  private readonly meter = metrics.getMeter('@keel/core');

  private readonly requestDuration: Histogram = this.meter.createHistogram(
    'http.server.request.duration',
    {
      description: 'Duration of inbound HTTP server requests.',
      unit: 's',
      valueType: ValueType.DOUBLE,
    },
  );

  private readonly activeRequests: Counter = this.meter.createUpDownCounter(
    'http.server.active_requests',
    {
      description: 'Number of in-flight inbound HTTP server requests.',
      unit: '{request}',
      valueType: ValueType.INT,
    },
  );

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = executionContext.switchToHttp();
    const request = http.getRequest<IncomingMessage>();
    const response = http.getResponse<ServerResponse>();

    const baseAttributes: Attributes = {
      'http.request.method': request.method ?? 'UNKNOWN',
      'http.route': routeTemplate(executionContext),
    };

    this.activeRequests.add(1, baseAttributes);
    const startNs = process.hrtime.bigint();

    // Record on response completion (not when the handler's Observable completes): the final
    // status code is only set once Nest/the exception filter has written the response, so
    // 'finish' (or 'close' if the connection drops first) gives the true status for both the
    // success and error paths. Guarded so the up-down counter decrements exactly once.
    let settled = false;
    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      this.requestDuration.record(durationSeconds, {
        ...baseAttributes,
        'http.response.status_code': response.statusCode,
      });
      this.activeRequests.add(-1, baseAttributes);
    };
    response.once('finish', settle);
    response.once('close', settle);

    return next.handle();
  }
}
