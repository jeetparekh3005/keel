import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** DI token for the configured CORS allow-origins (exact origins; `*` allows any). */
export const CORS_ALLOW_ORIGINS = Symbol('keel.CorsAllowOrigins');

/**
 * Deny-by-default CORS. No allow-origin header is emitted unless the request's Origin is
 * explicitly configured (or `*` is configured, which never combines a wildcard with
 * credentials). When no origins are configured the middleware is inert: a cross-origin
 * caller gets no CORS headers, so the browser blocks it. Mirrors the Go vertical's cors().
 */
@Injectable()
export class CorsMiddleware implements NestMiddleware {
  private readonly allowAny: boolean;
  private readonly allowed: ReadonlySet<string>;

  constructor(@Inject(CORS_ALLOW_ORIGINS) origins: string[]) {
    this.allowAny = origins.includes('*');
    this.allowed = new Set(origins);
  }

  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      if (this.allowAny) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      } else if (this.allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (res.getHeader('Access-Control-Allow-Origin')) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      }
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  }
}
