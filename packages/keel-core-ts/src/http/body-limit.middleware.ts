import type { IncomingMessage } from 'node:http';

import { Inject, Injectable, type NestMiddleware, PayloadTooLargeException } from '@nestjs/common';

import { MAX_BODY_BYTES } from './tokens.js';

/**
 * Content-type-agnostic request body limit (platform.yaml http: body_limit). The JSON body parser
 * only caps JSON payloads, so a text/plain, octet-stream, form, or unknown-content-type body would
 * otherwise bypass the limit. This rejects any request whose declared Content-Length exceeds the
 * cap with a 413, which the problem filter renders as RFC 9457 and the security-headers middleware
 * still decorates - matching the Go and Java verticals, which cap on Content-Length regardless of
 * type.
 */
@Injectable()
export class BodyLimitMiddleware implements NestMiddleware {
  constructor(@Inject(MAX_BODY_BYTES) private readonly maxBytes: number) {}

  use(req: IncomingMessage, _res: unknown, next: (err?: unknown) => void): void {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      next(new PayloadTooLargeException(`request body exceeds ${this.maxBytes} bytes`));
      return;
    }
    next();
  }
}
