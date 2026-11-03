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

- A shared **processor pipeline**: reserved-field namespacing (user `service=` becomes `x_service`), correlation ids from `keel_core.context`, `add_log_level` normalized to contract names (`warn`/`fatal`), ISO-8601 UTC timestamp, `format_exc_info` for real tracebacks, recursive redaction, event→`message` rename, JSON renderer.
- `configure_logging()` installs a root handler whose `ProcessorFormatter` runs the same chain, so **library logs come out as correlated JSON** in the same schema.
- The `Logger` port, the `platform.yaml` logging schema, and the test kit are unchanged — this is a pure adapter swap (the ports payoff).

### Deferred (stated honestly, with rationale)

- **Non-blocking / queue writes** — writes are synchronous to stdout. stdout latency is low and the collector handles downstream backpressure; revisit (QueueHandler + listener) if a hot path shows event-loop stalls.
- **Sampling / rate-limiting** — not yet; add when a high-volume service needs cost/noise control.
- **Value-pattern scrubbing and message-string redaction** — redaction is key-based (recursive). Secrets must not be placed in the message string; that is enforced separately (ADR-0007 semgrep rule) rather than scrubbed here.
- **Field-size caps** — add if oversized payloads become a problem.

## Consequences

- Good: tracebacks, recursive redaction, reserved-field safety, and a single correlated pipeline for app + library logs.
- Good: less code owned; structlog's processors are battle-tested.
- Bad: a dependency (structlog) and a startup step (`configure_logging`); the deferred items above are not yet covered.

## Enforcement

- Ruff `T20` (no `print`) and `LOG`/`G` (logging hygiene) keep logging going through the port.
- Secrets-in-message are blocked by the ADR-0007 semgrep rule, not by the logger.

## More information

- Realizes the `logging` section of [`platform.yaml`](../../platform.yaml); implements the `Logger` port ([ADR-0002](0002-hexagonal-architecture.md)).
