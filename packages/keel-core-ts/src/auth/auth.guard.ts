import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { DomainError, ErrorCategory } from '../domain/errors.js';
import {
  API_KEY_AUTHENTICATOR,
  type Authenticator,
  AUTHENTICATOR,
  Principal,
} from './principal.js';
import { IS_PUBLIC_KEY, SCOPES_KEY } from './scopes.decorator.js';

/**
 * The deny-by-default authentication/authorization guard. Registered globally (APP_GUARD) so
 * every route requires a verified caller unless it is explicitly @Public. A caller presents
 * either a bearer JWT (Authorization: Bearer) or an opaque API key (X-API-Key); whichever is
 * present is verified by its own authenticator. A missing or invalid credential is rejected
 * (401), a key-source outage is a 503, and an authenticated caller lacking a route's @Scopes
 * gets 403, all before the handler runs. Both credential kinds yield a Principal that flows
 * through the identical @Scopes check, so an API-key principal without the route's scope is
 * 403 just as a JWT one is. It attaches the verified Principal to the request. Thrown
 * DomainErrors are rendered as RFC 9457 problem+json by the global exception filter.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    // Optional: a service only wires this when it issues API keys. Absent it, an X-API-Key
    // request is rejected (there is nothing to verify it against) rather than silently allowed.
    @Optional()
    @Inject(API_KEY_AUTHENTICATOR)
    private readonly apiKeyAuthenticator?: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      principal?: Principal;
    }>();

    const principal = await this.verify(request.headers);
    request.principal = principal;

    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, targets) ?? [];
    if (required.length > 0 && !principal.hasScopes(...required)) {
      throw new DomainError(ErrorCategory.Forbidden, 'insufficient scope');
    }
    return true;
  }

  /**
   * Resolve the verified Principal from whichever credential the request carries. An X-API-Key
   * (when the service configured an api-key authenticator) takes precedence; otherwise the
   * Authorization bearer token is used. A request with neither is Unauthenticated.
   */
  private async verify(headers: Record<string, string | string[] | undefined>): Promise<Principal> {
    const apiKey = apiKeyHeader(headers['x-api-key']);
    if (apiKey !== null) {
      if (!this.apiKeyAuthenticator) {
        throw new DomainError(ErrorCategory.Unauthenticated, 'api-key authentication unavailable');
      }
      return this.apiKeyAuthenticator.authenticate(apiKey);
    }

    const token = bearerToken(headers['authorization']);
    if (!token) {
      throw new DomainError(ErrorCategory.Unauthenticated, 'missing bearer or api-key credential');
    }
    return this.authenticator.authenticate(token);
  }
}

/** The X-API-Key header value, trimmed, or null when absent/blank. */
function apiKeyHeader(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return null;
  }
  const key = value.trim();
  return key.length > 0 ? key : null;
}

/**
 * Extract the token from the Authorization header. The scheme is matched case-insensitively
 * per RFC 7235 (so "bearer" is accepted as well as "Bearer").
 */
function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return null;
  }
  const separator = value.indexOf(' ');
  if (separator < 0) {
    return null;
  }
  if (value.slice(0, separator).toLowerCase() !== 'bearer') {
    return null;
  }
  const token = value.slice(separator + 1).trim();
  return token.length > 0 ? token : null;
}
