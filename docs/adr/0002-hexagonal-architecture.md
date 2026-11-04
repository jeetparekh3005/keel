# 0002. Hexagonal architecture for generated services

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

keel's core promise is runnable-but-swappable cross-cutting concerns (auth, persistence, telemetry) behind stable interfaces, consistent across languages. We need an architecture for generated backend services that makes "swap the adapter, keep the domain" a first-class, enforced property - and that maps cleanly onto the shared [`platform.yaml`](../../platform.yaml) contract.

## Decision drivers

- The platform contract defines *ports*; verticals must provide *adapters*. The architecture should make that the literal shape of the code.
- Business logic must be testable without infrastructure.
- Swapping a provider (OIDC -> Auth0, Postgres -> MySQL) must be one wiring change, not a refactor.

## Considered options

- **Hexagonal / ports & adapters** (Cockburn)
- Layered / n-tier
- "Clean architecture" (concentric layers)

## Decision outcome

Chosen option: **hexagonal (ports & adapters) with light DDD**.

- **Domain** - pure business logic; depends on nothing external. Owns the port *interfaces*.
- **Application** - use cases orchestrating the domain and driven ports.
- **Adapters** - `inbound/` (driving: HTTP/CLI/consumers) and `outbound/` (driven: persistence, auth, telemetry) implementing the ports.
- **Composition root** - the single place that binds concrete adapters to ports. The *only* place that knows both sides, and therefore the only place a swap touches.

The driven ports are exactly the contract concerns: `Repository`, `Authenticator`, `Logger`, `Tracer`, `Meter`, `ConfigLoader`, `SecretProvider`, `Clock`. Because ports are language-agnostic concepts and adapters are language-specific, this is what makes "one contract, many languages" real.

Reference Python layout:

```
src/<service>/
  domain/            # entities, value objects, ports/ (interfaces) - NO I/O
  application/       # use cases
  adapters/
    inbound/http/    # FastAPI routers -> use cases      (driving)
    outbound/        # SQLAlchemy, OIDC, OTel impls       (driven)
  config/
  composition.py     # wires adapters -> ports (the swap point)
  main.py
```

### Guardrails (to avoid over-abstraction)

- A port marks a genuine boundary (I/O, external system), **not** every internal call. No port-per-function.
- Offer a lighter **"simple service"** variant for trivial CRUD that doesn't warrant full layering.
- Frontends keep their own idioms; hexagonal is for backend services.
- Light DDD (entities, value objects, application services) - **not** aggregates-everywhere dogma.

### Consequences

- Good: domain is unit-testable with fakes; adapters integration-tested with testcontainers.
- Good: adapter swaps are localized to the composition root.
- Bad: more indirection than n-tier; mitigated by the guardrails above.
- Neutral: contract conformance can be checked by a port-coverage test suite.

## Enforcement

Hexagonal boundaries are enforced deterministically in CI, not by review:

- **import-linter** contracts: `domain` must not import `application` or `adapters`; `application` must not import `adapters`; outbound adapters must not import one another.
- **Forbidden infra in domain:** `domain` must not import `sqlalchemy`, `fastapi`, `grpc`, `httpx`, or other I/O libraries.
- **Ruff `TID`** bans relative/forbidden imports as a first line.
- **Port conformance** is checked by mypy (ports as `Protocol`; the composition root is typed against them) - see [ADR-0010](0010-enforcement-strategy.md).

## More information

- Ports are defined by [`platform.yaml`](../../platform.yaml) and realized by each vertical (first: Python, issue #6).
- Comment/docstring rules: [ADR-0003](0003-code-comment-strategy.md).
