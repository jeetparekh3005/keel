# keel-core (Python)

Tier-1 shared library for keel Python services (see [ADR-0009](../../docs/adr/0009-shared-library-vs-generated-code.md)). It implements the platform contract ([`platform.yaml`](../../platform.yaml)) so services stay thin and consistent by construction.

## Layout (hexagonal — [ADR-0002](../../docs/adr/0002-hexagonal-architecture.md))

```
keel_core/
  ports/        # Protocols: Logger, Clock, Authenticator (+ Principal)
  domain/       # errors: taxonomy mapped to RFC 9457 (ADR + platform.yaml)
  adapters/
    outbound/   # StructuredLogger, SystemClock
  config.py     # BaseServiceConfig (typed, 12-factor, fail-fast)
  context.py    # request/trace/span contextvars injected into logs
  testkit/      # fakes: FrozenClock, StubAuthenticator, capturing_logger
```

## What's here now (slice 2 of #6)

- **Structured logging** (on structlog, [ADR-0014](../../docs/adr/0014-logging-implementation.md)) — contract-schema JSON, real exception tracebacks, recursive secret redaction, reserved-field protection, correlation ids from `context`, and `configure_logging()` to route stdlib/library logs through the same schema.
- **Error taxonomy** — `DomainError` hierarchy with category → HTTP status mapping.
- **Typed config** — `BaseServiceConfig` (Pydantic Settings), `KEEL_`-prefixed, immutable, fails fast.
- **Clock** — injectable time for testability.
- **Auth port** — `Authenticator` / `Principal` (OIDC adapter lands in the next slice).
- **Test kit** — fakes shipped so services test against the ports.

Coming next: the FastAPI app factory ([ADR-0013](../../docs/adr/0013-python-web-framework.md)), then persistence/auth/secrets adapters.

## Usage

```python
from keel_core.adapters.outbound.logging import StructuredLogger

log = StructuredLogger(service="orders", version="1.0.0")
log.info("order placed", order_id=42)  # -> one JSON line, secrets redacted
```
