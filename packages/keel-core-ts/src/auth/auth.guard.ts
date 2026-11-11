import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { DomainError, ErrorCategory } from '../domain/errors.js';
import { type Authenticator, AUTHENTICATOR, Principal } from './principal.js';
import { IS_PUBLIC_KEY, SCOPES_KEY } from './scopes.decorator.js';

/**
 * The deny-by-default authentication/authorization guard. Registered globally (APP_GUARD) so
 * every route requires a verified caller unless it is explicitly @Public. A missing or
 * invalid token is rejected (401), a key-source outage is a 503, and an authenticated caller
 * lacking a route's @Scopes gets 403, all before the handler runs. It attaches the verified
 * Principal to the request. Thrown DomainErrors are rendered as RFC 9457 problem+json by the
 * global exception filter.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
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

    const token = bearerToken(request.headers['authorization']);
    if (!token) {
      throw new DomainError(ErrorCategory.Unauthenticated, 'missing bearer token');
    }

    const principal = await this.authenticator.authenticate(token);
    request.principal = principal;

    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, targets) ?? [];
    if (required.length > 0 && !principal.hasScopes(...required)) {
      throw new DomainError(ErrorCategory.Forbidden, 'insufficient scope');
    }
    return true;
  }
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
