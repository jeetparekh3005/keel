# keel-core (Python)

Tier-1 shared library for keel Python services (see [ADR-0009](../../docs/adr/0009-shared-library-vs-generated-code.md)). It implements the platform contract ([`platform.yaml`](../../platform.yaml)) so services stay thin and consistent by construction.

## Layout (hexagonal - [ADR-0002](../../docs/adr/0002-hexagonal-architecture.md))

```
keel_core/
  ports/        # Protocols: Logger, Clock, Authenticator (+ Principal)
  domain/       # errors: taxonomy mapped to RFC 9457 (ADR + platform.yaml)
  adapters/
    inbound/http/      # FastAPI app factory, problem+json, health, deny-by-default auth
    inbound/rpc/       # gRPC server factory (OTel-instrumented)
    outbound/          # StructuredLogger, SystemClock
    outbound/rpc/      # gRPC ServiceClient channel factory (trace-propagating)
    outbound/messaging/ # MessageBus port + InMemory and NATS JetStream adapters
    outbound/auth/     # OIDCAuthenticator + ApiKeyAuthenticator
    outbound/secrets/  # EnvSecretProvider (prod: OpenBao)
    outbound/telemetry/ # OpenTelemetry tracing + metrics + saturation
    outbound/persistence/  # async SQLAlchemy: Database, UnitOfWork (repos are service-defined)
  config.py     # BaseServiceConfig (typed, 12-factor, fail-fast)
  context.py    # request/trace/span contextvars injected into logs
  testkit/      # fakes: FrozenClock, StubAuthenticator, capturing_logger
```

## What's here now

- **Structured logging** (on structlog, [ADR-0014](../../docs/adr/0014-logging-implementation.md)) - contract-schema JSON, real exception tracebacks, recursive secret redaction + value-pattern/message scrubbing, reserved-field protection, field-size caps, optional rate limiting, non-blocking background writer, correlation ids from `context`, and `configure_logging()` to route stdlib/library logs through the same schema.
- **Error taxonomy** - `DomainError` hierarchy with category -> HTTP status mapping.
- **Typed config** - `BaseServiceConfig` (Pydantic Settings), `KEEL_`-prefixed, immutable, fails fast.
- **Clock** - injectable time for testability.
- **Auth** - `Authenticator` / `Principal` port with `OIDCAuthenticator` (Bearer JWTs verified against the issuer JWKS; issuer/audience/expiry enforced; claims mapped to a `Principal`) and `ApiKeyAuthenticator` (SHA-256-hashed keys, accepted via `X-API-Key`).
- **Secrets** - `SecretProvider` port + `EnvSecretProvider` (dev); production uses OpenBao (ADR-0007). Secrets are reached only through the port.
- **Distributed tracing** - `configure_tracing()` installs an OpenTelemetry provider; FastAPI/Starlette then emit spans and continue inbound W3C trace context natively. The structured logger reads the active span, so every log line carries the correct `trace_id`/`span_id` with no wiring. OTLP export is configured at deployment.
- **gRPC** - `create_channel` (ServiceClient) and `create_server` (GrpcApi) factories carry the OpenTelemetry interceptors; the server enforces deny-by-default auth + scope authorization and publishes the `Principal` on a contextvar. mTLS credential builders (`mtls_channel_credentials`/`mtls_server_credentials`) via OpenBao PKI.
- **Messaging** - `MessageBus` port with `InMemoryMessageBus` (dev/test) and a durable `NatsMessageBus` (JetStream, explicit-ack, nak/DLQ), both injecting/extracting trace context. A reusable `assert_pubsub_roundtrip` contract both satisfy.
- **FastAPI app factory** ([ADR-0013](../../docs/adr/0013-python-web-framework.md)) - `create_app` wires request-id, problem+json (RFC 9457, incl. `invalid-params`), health, metrics, optional rate limiting, default-deny CORS, environment-gated docs, and a deny-by-default auth dependency. Requires an `Authenticator`.
- **Persistence** - async SQLAlchemy 2.0 plumbing: `Database`, `UnitOfWork`, the `Entity` base, and a bounded readiness `ping()`. Repositories are **service-defined** per aggregate (mapping ORM<->domain); keel-core ships no generic repository.
- **Test kit** - fakes + reusable contracts (messaging, health/problem conformance) so services test against the ports.

## Usage

```python
from keel_core.adapters.outbound.logging import StructuredLogger

log = StructuredLogger(service="orders", version="1.0.0")
log.info("order placed", order_id=42)  # -> one JSON line, secrets redacted
```
