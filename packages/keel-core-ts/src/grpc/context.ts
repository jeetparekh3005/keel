import { createContextKey } from '@connectrpc/connect';

import type { Principal } from '../auth/principal.js';

/**
 * Context key the auth interceptor uses to publish the authenticated Principal to the handler,
 * mirroring the Python factory's `principal_var` contextvar. A handler reads it with
 * `ctx.values.get(PRINCIPAL)`. It is undefined only on an exempt method (which skips
 * authentication); for every authenticated method the interceptor sets it before the handler
 * runs.
 */
export const PRINCIPAL = createContextKey<Principal | undefined>(undefined, {
  description: 'keel.grpc.Principal',
});
