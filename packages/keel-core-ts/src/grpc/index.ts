// The gRPC server surface for the TypeScript vertical (ADR-0022): a server factory that installs
// a deny-by-default auth interceptor and OpenTelemetry tracing by construction, mTLS credential
// builders, and the reference ItemService backed by an in-memory store. Serving uses the
// committed protobuf-es service descriptor via @connectrpc/connect-node (the gRPC protocol); no
// extra codegen plugin is needed, so the buf regeneration dogfood stays byte-identical.

export {
  type AuthInterceptorOptions,
  createAuthInterceptor,
  grpcMethodPath,
} from './auth-interceptor.js';
export { PRINCIPAL } from './context.js';
export { ITEM_SERVICE_SCOPES, InMemoryItemStore, registerItemService } from './item-service.js';
export {
  createGrpcHandler,
  createMutualTlsGrpcServer,
  type GrpcHandler,
  type GrpcServerOptions,
} from './server.js';
export { createTelemetryInterceptor } from './telemetry-interceptor.js';
export {
  clientTlsOptions,
  loadMutualTlsPem,
  type MutualTlsPem,
  type MutualTlsSecretKeys,
  serverTlsOptions,
} from './tls.js';
