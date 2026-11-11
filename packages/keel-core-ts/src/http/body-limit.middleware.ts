import type { IncomingMessage } from 'node:http';

import { Inject, Injectable, type NestMiddleware, PayloadTooLargeException } from '@nestjs/common';

import { MAX_BODY_BYTES } from './tokens.js';

/**
 * Content-type-agnostic request body limit (platform.yaml http: body_limit). The JSON body parser
 * only caps JSON payloads, so a text/plain, octet-stream, form, or unknown-content-type body would
 * otherwise bypass the limit. Two layers, matching the Go (http.MaxBytesReader) and Java
 * (LimitingServletInputStream) verticals which bound the actual stream:
 *   1. a fast reject when the declared Content-Length already exceeds the cap;
 *   2. a streaming byte counter that aborts a chunked / no-Content-Length body once it exceeds the
 *      cap, so a body that lies about or omits its length cannot buffer unboundedly.
 * Either way the rejection is a 413 that the problem filter renders as RFC 9457 and the
 * security-headers middleware still decorates.
 *
 * The counter only observes bytes (it never consumes the stream), and for a parsed content-type
 * (JSON) the global body parser has already drained the stream before this middleware runs, so the
 * listener sees nothing and normal requests are unaffected.
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

    let received = 0;
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > this.maxBytes) {
        req.removeListener('data', onData);
        // Destroy with a 413 the exception layer renders as problem+json. The response may have
        // begun for a truly streaming handler, but keel routes do not stream request bodies, so in
        // practice this aborts before any handler reads an over-limit chunked body.
        req.destroy(new PayloadTooLargeException(`request body exceeds ${this.maxBytes} bytes`));
      }
    };
    req.on('data', onData);
    req.once('end', () => req.removeListener('data', onData));
    next();
  }
}
