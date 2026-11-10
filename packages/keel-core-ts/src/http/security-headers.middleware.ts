import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Sets the always-on security headers (only if a route has not already set them). Registered
 * outermost, so even a short-circuited response (e.g. a body-limit 413) carries them. HSTS is
 * emitted unconditionally: browsers ignore it over plaintext.
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  use(_req: IncomingMessage, res: ServerResponse, next: () => void): void {
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
    next();
  }
}

function setIfAbsent(res: ServerResponse, name: string, value: string): void {
  if (!res.getHeader(name)) {
    res.setHeader(name, value);
  }
}
