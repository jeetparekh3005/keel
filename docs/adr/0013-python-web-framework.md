# 0013. Python web framework

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

The Python vertical needs a web framework for the inbound HTTP adapter. Under hexagonal (ADR-0002) the framework only implements the `HttpApi` driving port - it calls use cases and nothing in the domain/application depends on it - so the choice should optimize for being a *thin adapter* with native OpenAPI and Pydantic, not for being the center of the application.

## Decision drivers

- Native OpenAPI (treated as a contract artifact) and Pydantic v2 boundary validation.
- Async-first (pairs with async SQLAlchemy, gRPC, OTel).
- Must stay a thin driving adapter - not couple the domain to the framework.
- Ecosystem maturity and talent pool.

## Considered options

| Framework | Async-first | OpenAPI + Pydantic | Thin adapter | DI | Ecosystem |
|---|---|---|---|---|---|
| **FastAPI** | Yes | Native | Yes | `Depends` | Largest |
| Litestar | Yes | Native | Yes | First-class DI | Smaller |
| Django + DRF | Partial | via drf-spectacular | No (ORM/model-centric) | N/A | Large |
| Flask / Quart | Quart only | Manual | Yes | Manual | Large |

## Decision outcome

Chosen option: **FastAPI as the default, with the inbound HTTP adapter isolated so a Litestar adapter can be added later.**

- `keel-core-py` provides a FastAPI **app factory** that wires the contract middleware (auth dependency, request-id, tracing, RFC 9457 error handler) and exposes the health endpoints.
- Framework code lives only in `adapters/inbound/http/` (e.g. a `http_fastapi` module). The use-case layer it calls is framework-agnostic, so a future `http_litestar` adapter is a drop-in without touching domain/application.
- **Django is rejected** for this platform: it is ORM/model-centric by design and fights ports-and-adapters, and its async story is only partial. It remains the right tool for admin/CMS/CRUD-monolith apps - which this platform is not.

### Consequences

- Good: native OpenAPI + Pydantic, async, largest ecosystem; the framework stays a thin adapter.
- Good: the Litestar escape hatch keeps the choice reversible per service.
- Bad: maintaining a second (Litestar) adapter later is extra surface; deferred until there is demand.
- Neutral: `Depends` is adequate for wiring; the composition root remains the authoritative swap point.

## More information

- Inbound adapter shape follows [ADR-0002](0002-hexagonal-architecture.md); realizes the `HttpApi` driving port in [`platform.yaml`](../../platform.yaml).
- Delivered by `keel-core-py` (slice 2 of #6).
