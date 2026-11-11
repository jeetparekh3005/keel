import type { IncomingMessage } from 'node:http';

import { Inject, Injectable, type NestMiddleware, PayloadTooLargeException } from '@nestjs/common';

import { MAX_BODY_BYTES } from './tokens.js';

/**
 * Content-type-agnostic request body limit (platform.yaml http: body_limit). The JSON body parser
 * only caps JSON payloads, so a text/plain, octet-stream, form, or unknown-content-type body would
 * otherwise bypass the limit. Two layers:
 *   1. a fast reject when the declared Content-Length already exceeds the cap. This returns a
 *      proper 413 (next(err)) that the problem filter renders as RFC 9457 and the security-headers
 *      middleware decorates - the common path.
 *   2. a streaming byte counter that ABORTS the connection once a chunked / no-Content-Length body
 *      exceeds the cap, so a body that lies about or omits its length cannot buffer unboundedly.
 *      This is a hard socket reset (ECONNRESET on the client), not a decorated 413: it is the
 *      anti-buffering backstop for a malformed/oversized request, not a well-formed error response.
 *      (Go/Java wrap the stream and return a 413 body; here the common Content-Length path returns
 *      the decorated 413 and the streaming path only bounds buffering.)
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
        // Abort the connection to bound buffering. This is a socket reset, NOT a decorated 413
        // (that would require writing a response mid-stream, outside the exception filter); the
        // Content-Length fast path above returns the proper 413 for the common, well-formed case.
        req.destroy(new PayloadTooLargeException(`request body exceeds ${this.maxBytes} bytes`));
      }
    };
    req.on('data', onData);
    req.once('end', () => req.removeListener('data', onData));
    next();
  }
}
