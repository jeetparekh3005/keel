import type { ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { createSecureServer, type Http2SecureServer } from 'node:http2';

import type { Authenticator } from '../auth/principal.js';
import { type AuthInterceptorOptions, createAuthInterceptor } from './auth-interceptor.js';
import { createTelemetryInterceptor } from './telemetry-interceptor.js';
import { type MutualTlsPem, serverTlsOptions } from './tls.js';

/** The Node http2 request handler a ConnectRouter compiles to. */
export type GrpcHandler = ReturnType<typeof connectNodeAdapter>;

/** Options for the gRPC server factory: the Authenticator, the routes, and the auth policy. */
export interface GrpcServerOptions extends AuthInterceptorOptions {
  /**
   * The Authenticator every call is verified against. Required: because the factory installs the
   * auth interceptor around the routes, a servicer cannot be exposed unauthenticated.
   */
  authenticator: Authenticator;
  /** Register the service implementations on the router (e.g. `(r) => registerItemService(r, store)`). */
  routes: (router: ConnectRouter) => void;
}

/**
 * Build the Node http2 request handler for the registered gRPC services with the deny-by-default
 * auth interceptor and OpenTelemetry tracing installed BY CONSTRUCTION, mirroring the Python
 * `create_server` factory. The telemetry interceptor is outermost (its span wraps auth and the
 * handler); the auth interceptor runs next, before any handler, so no route can be served without
 * a verified Principal unless it is explicitly exempt. Serve the returned handler over mTLS with
 * createMutualTlsGrpcServer (or any http2 secure server).
 */
export function createGrpcHandler(options: GrpcServerOptions): GrpcHandler {
  const { authenticator, routes, ...authOptions } = options;
  return connectNodeAdapter({
    routes,
    // Connect applies the last interceptor in the array first (outermost): telemetry wraps auth,
    // auth wraps the handler.
    interceptors: [createAuthInterceptor(authenticator, authOptions), createTelemetryInterceptor()],
  });
}

/**
 * Wrap a gRPC handler in an http2 secure server that requires and verifies client certificates
 * against the given mTLS material (mutual TLS). Call .listen(...) on the result to serve.
 */
export function createMutualTlsGrpcServer(
  pem: MutualTlsPem,
  handler: GrpcHandler,
): Http2SecureServer {
  return createSecureServer(serverTlsOptions(pem), handler);
}
