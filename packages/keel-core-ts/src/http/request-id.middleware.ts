import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Request augmented with the correlation id resolved by RequestIdMiddleware. */
export type RequestWithId = IncomingMessage & { id?: string };

const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Propagates a client X-Request-Id or mints a fresh UUID, echoes it on the response, and
 * stores it on the request so logs and handlers can correlate.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithId, res: ServerResponse, next: () => void): void {
    const incoming = req.headers['x-request-id'];
    const id = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
    req.id = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  }
}
