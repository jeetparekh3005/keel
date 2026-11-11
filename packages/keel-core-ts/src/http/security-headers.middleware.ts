import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Apply the always-on security headers to a response (only if not already set). Exported so
 * both the edge middleware and the exception filter use it: a short-circuited error response
 * (e.g. a body-limit 413, which Express routes straight to the error handler, bypassing route
 * middleware) still carries the headers. HSTS is emitted unconditionally; browsers ignore it
 * over plaintext.
 */
export function applySecurityHeaders(res: ServerResponse): void {
  setIfAbsent(res, 'Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  setIfAbsent(res, 'X-Content-Type-Options', 'nosniff');
  setIfAbsent(res, 'X-Frame-Options', 'DENY');
  setIfAbsent(res, 'Referrer-Policy', 'no-referrer');
  setIfAbsent(
    res,
    'Permissions-Policy',
    'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  );
  setIfAbsent(res, 'Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** Sets the always-on security headers on every response. */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  use(_req: IncomingMessage, res: ServerResponse, next: () => void): void {
    applySecurityHeaders(res);
    next();
  }
}

function setIfAbsent(res: ServerResponse, name: string, value: string): void {
  if (!res.getHeader(name)) {
    res.setHeader(name, value);
  }
}
