// @keel/core: the shared platform library for the TypeScript/NestJS vertical. The
// conformance suite and testkit are separate entry points (@keel/core/conformance,
// @keel/core/testkit) so test-only helpers stay out of the production surface.

export {
  DomainError,
  ErrorCategory,
  isDomainError,
  isServerFault,
  type Problem,
  statusFor,
  titleFor,
  typeUriFor,
} from './domain/errors.js';

export { csvList, loadConfig } from './config/index.js';

export {
  createLogger,
  createNestLogger,
  isSecretKey,
  NestLoggerAdapter,
  redactValue,
  scrubText,
  REDACTED,
  type Logger,
} from './logging/index.js';

export {
  initTelemetry,
  observeDbPool,
  type ObserveDbPoolOptions,
  type PoolStatsSource,
  type TelemetryOptions,
} from './telemetry/index.js';

export { type Clock, CLOCK, type SecretProvider, SECRET_PROVIDER } from './ports/index.js';
export { EnvSecretProvider, SystemClock } from './adapters/index.js';

export { Database, DATABASE, type PoolStats, UnitOfWork } from './persistence/index.js';

export {
  type Authenticator,
  AUTHENTICATOR,
  AuthGuard,
  CurrentPrincipal,
  IS_PUBLIC_KEY,
  OidcAuthenticator,
  Principal,
  Public,
  SCOPES_KEY,
  Scopes,
} from './auth/index.js';

export {
  BodyLimitMiddleware,
  CORS_ALLOW_ORIGINS,
  CorsMiddleware,
  HealthController,
  LOGGER,
  MAX_BODY_BYTES,
  ProblemExceptionFilter,
  READINESS,
  type ReadinessCheck,
  RequestIdMiddleware,
  type RequestWithId,
  SecurityHeadersMiddleware,
  ZodValidationPipe,
} from './http/index.js';

export {
  DEFAULT_MAX_BODY_BYTES,
  type KeelCoreAsyncOptions,
  KeelCoreModule,
  type KeelCoreOptions,
} from './keel-core.module.js';
