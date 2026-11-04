# 0014. Logging implementation

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

The `Logger` port must be implemented to an enterprise-grade standard. A first hand-rolled adapter emitted the right JSON schema but had real gaps: `exception()` dropped the traceback, user fields could clobber reserved fields, redaction was top-level only, and — most importantly — it ran parallel to stdlib `logging`, so third-party library logs (uvicorn, SQLAlchemy, httpx, gRPC) bypassed the schema entirely and were uncorrelated.

## Decision drivers

- Real exception tracebacks and recursive secret redaction.
- One structured, trace-correlated pipeline for *all* logs, including libraries'.
- Battle-tested, not hand-rolled.
- The `Logger` port and the `platform.yaml` logging schema must not change.

## Considered options

| Option | Tracebacks | Recursive redaction | Captures stdlib/library logs | Maturity |
|---|---|---|---|---|
| **structlog (+ stdlib bridge)** | Yes | Yes (processor) | Yes (`ProcessorFormatter`) | High |
| stdlib + python-json-logger | Manual | Manual | Yes | High |
| loguru | Yes | Manual | Partial | High |
| Hand-rolled (previous) | No | No | No | n/a |

## Decision outcome

Chosen option: **implement the `Logger` port on structlog**, with a stdlib `ProcessorFormatter` bridge.

- A shared **processor pipeline**: reserved-field namespacing (user `service=` becomes `x_service`), correlation ids from `keel_core.context`, `add_log_level` normalized to contract names (`warn`/`fatal`), ISO-8601 UTC timestamp, `format_exc_info` for real tracebacks, recursive redaction, event->`message` rename, JSON renderer.
- `configure_logging()` installs a root handler whose `ProcessorFormatter` runs the same chain, so **library logs come out as correlated JSON** in the same schema.
- The `Logger` port, the `platform.yaml` logging schema, and the test kit are unchanged — this is a pure adapter swap (the ports payoff).

### Hardening (implemented)

- **Non-blocking writes** — `QueueLogWriter` enqueues to a bounded queue drained by a daemon thread; on overflow it drops-and-counts rather than blocking the caller. `configure_logging(non_blocking=True)` returns it so the service `stop()`s it at shutdown.
- **Rate limiting** — optional `RateLimiter` (token-bucket, keyed by message, never limits error/fatal); suppressed counts surface as `rate_limited_dropped` on the next admitted event, so nothing is silently lost.
- **Value-pattern + message scrubbing** — narrow, high-precision patterns (JWT, AWS key id, Bearer token, PEM private key, Luhn-valid card numbers) are scrubbed from every string value **and the message**, on top of key-based redaction.
- **Field-size caps** — string values over `max_field_len` (default 8 KB) are truncated with a byte-count marker.

These are defense-in-depth, not a substitute for not logging secrets: the ADR-0007 semgrep rule still bars secrets in the message at author time.

## Consequences

- Good: tracebacks, recursive redaction, reserved-field safety, and a single correlated pipeline for app + library logs.
- Good: less code owned; structlog's processors are battle-tested.
- Good: non-blocking output, rate limiting, value-pattern scrubbing, and size caps are all in place.
- Bad: a dependency (structlog), a startup step (`configure_logging`), and a background writer thread to stop at shutdown.

## Enforcement

- Ruff `T20` (no `print`) and `LOG`/`G` (logging hygiene) keep logging going through the port.
- Secrets-in-message are blocked by the ADR-0007 semgrep rule, not by the logger.

## More information

- Realizes the `logging` section of [`platform.yaml`](../../platform.yaml); implements the `Logger` port ([ADR-0002](0002-hexagonal-architecture.md)).
