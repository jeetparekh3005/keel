# keelyard

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
- **Ports / adapters / testkit** - `Clock` / `SecretProvider` / `MessageBus` seams and in-memory
  fakes. Production `SecretProvider` backends: OpenBao/Vault (ADR-0023), AWS Secrets Manager, and
  GCP Secret Manager (ADR-0024) over one caching core, selected fail-closed at most one.
- **Messaging** - `MessageBus` port with an in-memory bus and durable NATS JetStream, Kafka
  (`kafkajs`), and RabbitMQ (`amqplib`) adapters (at-least-once, ack/nak/dead-letter, W3C trace
  propagation), selected fail-closed at most one via `messageBusFromEnv` (`KEEL_NATS_URL` /
  `KEEL_KAFKA_BROKERS` / `KEEL_RABBITMQ_URL`; ADR-0025). Broker clients are subpath-only imports,
  so the default build stays broker-free.
- **Conformance** (`keelyard/conformance`) - the behavioral contract suite a service runs
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
pnpm --filter keelyard run build      # emit dist (consumed by the service)
pnpm --filter keelyard run lint        # typescript-eslint, type-checked
pnpm --filter keelyard run typecheck   # tsc --noEmit
pnpm --filter keelyard run test        # vitest (+ SWC for decorator metadata)
```
