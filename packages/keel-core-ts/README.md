# @keel/core

The shared keel platform library for the TypeScript/NestJS vertical (ADR-0019). It holds the
cross-cutting behavior every service needs, as NestJS-native providers, guards, interceptors,
filters, and middleware, so services stay thin (ADR-0009 Tier 1). The deliberate contrast to
the stdlib-first Go/Rust verticals: batteries-included, dependency-injected.

## What it provides

- **Config** - `loadConfig(schema)`: typed, `KEEL_`-prefixed, fail-fast config via zod. The
  same library validates request DTOs (`ZodValidationPipe`).
- **Errors** - the RFC 9457 taxonomy (`DomainError`, `ErrorCategory`, `toProblem`); 5xx detail
  is dropped from the client response and logged server-side.
- **Logging** - `createLogger`: pino JSON with family-based secret redaction + value scrubbing
  (JWT/AWS/bearer/PEM/Luhn, written ReDoS-safe) and per-line trace correlation.
- **Telemetry** - `initTelemetry`: OpenTelemetry tracing with OTLP export (off when no endpoint).
- **HTTP edge** - security headers, request-id, body limit, deny-by-default CORS, health probes,
  and the problem+json exception filter.
- **Auth** - `OidcAuthenticator` (jose; native JWKS refresh, Entra `scp`-string support) and a
  structurally deny-by-default guard with `@Public` / `@Scopes` decorators.
- **Persistence** - `Database` (pg pool) + `UnitOfWork`; services define their own repository
  per aggregate (ADR-0009).
- **Ports / adapters / testkit** - `Clock` / `SecretProvider` seams, their production adapters,
  and in-memory fakes.
- **Conformance** (`@keel/core/conformance`) - the behavioral contract suite a service runs
  against its composed app, so an over-claim fails a test.

## Wiring a service

```ts
@Module({
  imports: [
    KeelCoreModule.forRootAsync({
      imports: [InfraModule],
      inject: [REFERENCE_CONFIG, DATABASE],
      useFactory: (config, db) => ({
        logLevel: config.LOG_LEVEL,
        corsAllowOrigins: config.CORS_ALLOW_ORIGINS,
        authenticator: new OidcAuthenticator(config.OIDC_ISSUER, config.OIDC_AUDIENCE, config.OIDC_JWKS_URI),
        readiness: () => db.ping(),
      }),
    }),
    ItemsModule,
  ],
})
export class AppModule {}
```

See `services/reference-service-nest` for the full reference service.

## Develop

```sh
pnpm --filter @keel/core run build      # emit dist (consumed by the service)
pnpm --filter @keel/core run lint        # typescript-eslint, type-checked
pnpm --filter @keel/core run typecheck   # tsc --noEmit
pnpm --filter @keel/core run test        # vitest (+ SWC for decorator metadata)
```
