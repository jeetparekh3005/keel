// The composition module for the TypeScript vertical: it registers the deny-by-default auth
// guard, the RFC 9457 exception filter, the health probes, and the edge middleware (security
// headers, request-id, deny-by-default CORS) as NestJS-native providers, so services stay
// thin (ADR-0009 Tier 1). A service wires its adapters in via forRootAsync.
import {
  type DynamicModule,
  Global,
  type InjectionToken,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { API_KEY_AUTHENTICATOR, type Authenticator, AUTHENTICATOR } from './auth/principal.js';
import { AuthGuard } from './auth/auth.guard.js';
import { createLogger } from './logging/logger.js';
import { BodyLimitMiddleware } from './http/body-limit.middleware.js';
import { CorsMiddleware, CORS_ALLOW_ORIGINS } from './http/cors.middleware.js';
import { HealthController } from './http/health.controller.js';
import { ProblemExceptionFilter } from './http/problem.filter.js';
import { MetricsInterceptor } from './http/metrics.interceptor.js';
import { RequestIdMiddleware } from './http/request-id.middleware.js';
import { SecurityHeadersMiddleware } from './http/security-headers.middleware.js';
import { TracingInterceptor } from './http/tracing.interceptor.js';
import { LOGGER, MAX_BODY_BYTES, READINESS, type ReadinessCheck } from './http/tokens.js';

/** The default request body cap (1 MiB), bounding the large-payload DoS vector. */
export const DEFAULT_MAX_BODY_BYTES = 1 << 20;

const KEEL_OPTIONS = Symbol('keel.CoreOptions');

/** Everything the core module needs from the service to wire the platform contract. */
export interface KeelCoreOptions {
  /** Log level: debug | info | warn | error (unknown falls back to info). */
  logLevel: string;
  /** Exact CORS origins to allow; empty is deny-by-default (no CORS). `*` allows any. */
  corsAllowOrigins: string[];
  /** The authenticator that verifies bearer tokens (OIDC in prod, a stub in tests). */
  authenticator: Authenticator;
  /**
   * Optional authenticator for opaque X-API-Key credentials (an ApiKeyAuthenticator). When set,
   * the guard verifies an X-API-Key request against it; its principal is subject to the same
   * @Scopes checks. Omit it for bearer-only services.
   */
  apiKeyAuthenticator?: Authenticator;
  /** Readiness check backing /readyz (e.g. a DB ping). */
  readiness: ReadinessCheck;
  /** Request body cap in bytes (content-type-agnostic); defaults to DEFAULT_MAX_BODY_BYTES. */
  maxBodyBytes?: number;
}

/** Async options so a service can build KeelCoreOptions from its own injected providers. */
export interface KeelCoreAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (...args: never[]) => KeelCoreOptions | Promise<KeelCoreOptions>;
}

@Global()
@Module({})
export class KeelCoreModule implements NestModule {
  /** Wire the core with static options (handy for tests and simple services). */
  static forRoot(options: KeelCoreOptions): DynamicModule {
    return KeelCoreModule.forRootAsync({ useFactory: () => options });
  }

  /** Wire the core with options derived from the service's own injected providers. */
  static forRootAsync(options: KeelCoreAsyncOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: KEEL_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      {
        provide: LOGGER,
        useFactory: (opts: KeelCoreOptions) => createLogger(opts.logLevel),
        inject: [KEEL_OPTIONS],
      },
      {
        provide: AUTHENTICATOR,
        useFactory: (opts: KeelCoreOptions) => opts.authenticator,
        inject: [KEEL_OPTIONS],
      },
      {
        // Undefined when the service configures no API keys; the guard then treats the bearer
        // path as the only credential (and rejects an X-API-Key request).
        provide: API_KEY_AUTHENTICATOR,
        useFactory: (opts: KeelCoreOptions) => opts.apiKeyAuthenticator,
        inject: [KEEL_OPTIONS],
      },
      {
        provide: READINESS,
        useFactory: (opts: KeelCoreOptions): ReadinessCheck => opts.readiness,
        inject: [KEEL_OPTIONS],
      },
      {
        provide: CORS_ALLOW_ORIGINS,
        useFactory: (opts: KeelCoreOptions) => opts.corsAllowOrigins,
        inject: [KEEL_OPTIONS],
      },
      {
        provide: MAX_BODY_BYTES,
        useFactory: (opts: KeelCoreOptions) => opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        inject: [KEEL_OPTIONS],
      },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ProblemExceptionFilter },
      { provide: APP_INTERCEPTOR, useClass: TracingInterceptor },
      { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    ];

    return {
      module: KeelCoreModule,
      imports: options.imports ?? [],
      controllers: [HealthController],
      providers,
      exports: [LOGGER, AUTHENTICATOR, API_KEY_AUTHENTICATOR, READINESS, CORS_ALLOW_ORIGINS],
    };
  }

  // Apply the edge middleware to every route, outer-to-inner: security headers (outermost)
  // decorate every response, then request-id, then deny-by-default CORS, then the body-size cap
  // (a 413 here still carries the headers set above and is rendered as RFC 9457 by the filter).
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(SecurityHeadersMiddleware, RequestIdMiddleware, CorsMiddleware, BodyLimitMiddleware)
      .forRoutes('*');
  }
}
