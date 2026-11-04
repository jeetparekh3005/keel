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
    outbound/messaging/ # MessageBus port + InMemory adapter (prod: NATS/Kafka/RabbitMQ)
    outbound/auth/     # OIDCAuthenticator (JWT/JWKS validation)
    outbound/secrets/  # EnvSecretProvider (prod: OpenBao)
    outbound/telemetry/ # OpenTelemetry tracing setup (configure_tracing)
    outbound/persistence/  # async SQLAlchemy: Database, UnitOfWork, SqlAlchemyRepository
  config.py     # BaseServiceConfig (typed, 12-factor, fail-fast)
  context.py    # request/trace/span contextvars injected into logs
  testkit/      # fakes: FrozenClock, StubAuthenticator, capturing_logger
```

## What's here now (slice 2 of #6)

- **Structured logging** (on structlog, [ADR-0014](../../docs/adr/0014-logging-implementation.md)) - contract-schema JSON, real exception tracebacks, recursive secret redaction + value-pattern/message scrubbing, reserved-field protection, field-size caps, optional rate limiting, non-blocking background writer, correlation ids from `context`, and `configure_logging()` to route stdlib/library logs through the same schema.
- **Error taxonomy** - `DomainError` hierarchy with category -> HTTP status mapping.
- **Typed config** - `BaseServiceConfig` (Pydantic Settings), `KEEL_`-prefixed, immutable, fails fast.
- **Clock** - injectable time for testability.
- **Auth** - `Authenticator` / `Principal` port + `OIDCAuthenticator` adapter: verifies Bearer JWTs against the issuer's signing key (JWKS in prod), checks issuer/audience/expiry, maps claims (scopes, roles) to a `Principal`.
- **Secrets** - `SecretProvider` port + `EnvSecretProvider` (dev); production uses OpenBao (ADR-0007). Secrets are reached only through the port.
- **Distributed tracing** - `configure_tracing()` installs an OpenTelemetry provider; FastAPI/Starlette then emit spans and continue inbound W3C trace context natively. The structured logger reads the active span, so every log line carries the correct `trace_id`/`span_id` with no wiring. OTLP export is configured at deployment.
- **gRPC** - `create_channel` (ServiceClient) and `create_server` (GrpcApi) factories carry the official OpenTelemetry interceptors, so east-west calls propagate the trace. mTLS-ready via OpenBao credentials.
- **Messaging** - `MessageBus` port + `InMemoryMessageBus` (dev/test) that injects/extracts trace context so handlers correlate to the publisher's trace. NATS/Kafka/RabbitMQ adapters slot in behind the port at deployment.
- **FastAPI app factory** ([ADR-0013](../../docs/adr/0013-python-web-framework.md)) - `create_app` wires request-id propagation, problem+json error handling (RFC 9457), health endpoints, and a deny-by-default auth dependency. Requires an `Authenticator`, so an app cannot be built without auth.
- **Persistence** - `Repository` port + async SQLAlchemy 2.0 adapter (`Database`, `UnitOfWork`, generic `SqlAlchemyRepository`) with a readiness `ping()`. Domain depends on the port, never the ORM.
- **Test kit** - fakes shipped so services test against the ports.

Coming next: OIDC auth adapter and secrets (OpenBao); real-Postgres integration arrives with the reference service's docker-compose.

## Usage

```python
from keel_core.adapters.outbound.logging import StructuredLogger

log = StructuredLogger(service="orders", version="1.0.0")
log.info("order placed", order_id=42)  # -> one JSON line, secrets redacted
```
