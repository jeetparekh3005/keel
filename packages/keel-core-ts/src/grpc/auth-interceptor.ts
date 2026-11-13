import type { DescMethod, DescService } from '@bufbuild/protobuf';
import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';

import { type Authenticator, Principal } from '../auth/principal.js';
import { DomainError, ErrorCategory } from '../domain/errors.js';
import { PRINCIPAL } from './context.js';

const BEARER_PREFIX = 'bearer ';

/** Configuration for the deny-by-default gRPC auth interceptor. */
export interface AuthInterceptorOptions {
  /**
   * Full method paths ("/keel.reference.v1.ItemService/GetItem") that bypass authentication,
   * reserved for unauthenticated edges such as health/reflection. Everything else is closed.
   */
  exempt?: Iterable<string>;
  /**
   * Per-method required scopes, keyed by full method path. A method absent from this map still
   * requires a valid Bearer token (deny-by-default); it simply has no extra scope gate. A method
   * present here additionally requires the listed scopes or the call is PERMISSION_DENIED.
   */
  requiredScopes?: Record<string, readonly string[]>;
}

/**
 * The canonical gRPC method path ("/<service>/<Method>") the Python factory uses as its map key,
 * built from the protobuf service type name and the proto method name on the wire.
 */
export function grpcMethodPath(service: DescService, method: DescMethod): string {
  return `/${service.typeName}/${method.name}`;
}

/**
 * Build the deny-by-default authentication + authorization interceptor, matching the Python gRPC
 * factory's `AuthInterceptor`. For every non-exempt method it extracts the Bearer token from the
 * `authorization` metadata, verifies it through the given Authenticator, enforces the method's
 * required scopes, and publishes the resulting Principal on the handler context (PRINCIPAL). A
 * missing/malformed token or a verification failure is UNAUTHENTICATED (gRPC 16), an insufficient
 * scope is PERMISSION_DENIED (gRPC 7), and a signing-key/dependency outage is UNAVAILABLE (gRPC
 * 14) so a caller's valid credential is not discarded. Because the server factory installs this
 * interceptor, a servicer cannot be exposed unauthenticated.
 */
export function createAuthInterceptor(
  authenticator: Authenticator,
  options: AuthInterceptorOptions = {},
): Interceptor {
  const exempt = new Set(options.exempt ?? []);
  const required = new Map<string, readonly string[]>(Object.entries(options.requiredScopes ?? {}));

  return (next) => async (req) => {
    const path = grpcMethodPath(req.service, req.method);
    if (!exempt.has(path)) {
      const principal = await authenticateAndAuthorize(
        authenticator,
        req.header,
        required.get(path) ?? [],
      );
      // The handler reads this via ctx.values.get(PRINCIPAL); contextValues is the same object
      // the HandlerContext exposes, so the set here reaches the handler.
      req.contextValues.set(PRINCIPAL, principal);
    }
    return next(req);
  };
}

/** Verify the Bearer credential and enforce the required scopes, or throw the right gRPC status. */
async function authenticateAndAuthorize(
  authenticator: Authenticator,
  header: Headers,
  requiredScopes: readonly string[],
): Promise<Principal> {
  const token = bearerToken(header.get('authorization'));
  if (token === null) {
    throw new ConnectError('missing or malformed bearer token', Code.Unauthenticated);
  }
  let principal: Principal;
  try {
    principal = await authenticator.authenticate(token);
  } catch (err) {
    throw toConnectError(err);
  }
  if (requiredScopes.length > 0 && !principal.hasScopes(...requiredScopes)) {
    throw new ConnectError('insufficient scope', Code.PermissionDenied);
  }
  return principal;
}

/**
 * Extract the token from the Authorization metadata. The scheme is matched case-insensitively
 * per RFC 7235 (so "bearer" is accepted as well as "Bearer"), mirroring the HTTP AuthGuard.
 */
function bearerToken(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  if (!header.toLowerCase().startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Map an Authenticator failure to a gRPC status: a signing-key/dependency outage (Unavailable) is
 * retryable and must not be reported as an auth failure, so it becomes UNAVAILABLE; every other
 * failure is UNAUTHENTICATED.
 */
function toConnectError(err: unknown): ConnectError {
  if (err instanceof DomainError && err.category === ErrorCategory.Unavailable) {
    return new ConnectError('auth dependency unavailable', Code.Unavailable);
  }
  return new ConnectError('invalid token', Code.Unauthenticated);
}
