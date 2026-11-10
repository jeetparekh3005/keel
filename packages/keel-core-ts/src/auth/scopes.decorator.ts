import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';

import type { Principal } from './principal.js';

/** Metadata key: route is exempt from authentication (health probes only). */
export const IS_PUBLIC_KEY = 'keel:isPublic';

/** Metadata key: scopes the route's principal must hold. */
export const SCOPES_KEY = 'keel:scopes';

/**
 * Exempt a route from the deny-by-default auth guard. Reserve for unauthenticated edges such
 * as health probes; everything else is authenticated by default.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Require the caller's principal to hold all of the given scopes (403 otherwise). */
export const Scopes = (...scopes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(SCOPES_KEY, scopes);

/** Inject the authenticated Principal attached to the request by the auth guard. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | undefined => {
    const request = ctx.switchToHttp().getRequest<{ principal?: Principal }>();
    return request.principal;
  },
);
