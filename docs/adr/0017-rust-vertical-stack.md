# 0017. Rust vertical stack

- **Status:** accepted
- **Date:** 2026-11-05
- **Deciders:** Jeet Parekh

## Context and problem statement

v0.3 adds a second language vertical: `keel-core-rust` plus a thin reference
service that satisfies the same [`platform.yaml`](../../platform.yaml) contract as
the Python vertical (ADR-0009 tiers, ADR-0002 hexagonal). The Rust vertical is the
contract's stress-test: Rust's type system should raise the enforcement floor, and
building it must not require changing the contract. We need to choose the async
runtime, HTTP framework, and the crate for each contract concern, all from the
mature, actively-maintained, OSS tier.

## Decision drivers

- Satisfy every platform.yaml concern (logging, errors, http edge, auth, telemetry,
  persistence, health, interservice) with first-class crates.
- Idiomatic async; one runtime the whole stack shares.
- A `tower`-based middleware model so the HTTP edge concerns (security headers,
  body limit, CORS, request-id, rate limit) compose the way keel-core-py's ASGI
  middleware stack does.
- Native OpenTelemetry (learning from v0.2: assume current native instrumentation,
  verify against the runtime).

## Considered options (HTTP framework)

| Framework | Runtime | Middleware model | Ecosystem fit | Notes |
|---|---|---|---|---|
| **axum** | tokio | `tower`/`tower-http` | Excellent (hyper/tower/tracing all align) | Tokio-native, the current mainstream default; middleware maps cleanly to our ordered-stack model |
| actix-web | actix (own) | actix middleware | Diverges from tower | Very high throughput, mature, but its own actor runtime and middleware idiom split it from the tower ecosystem the rest of the stack uses |
| warp | tokio | filters | Smaller | Filter-combinator style is powerful but less approachable for a golden-path exemplar |
| poem / salvo | tokio | own | Smaller | Capable but smaller communities |

## Decision outcome

**axum on tokio, with tower/tower-http for middleware.** It is tokio-native, so the
whole stack (HTTP, gRPC via tonic, NATS via async-nats, SQLx) shares one runtime,
and its `tower` middleware model mirrors the ordered ASGI stack in keel-core-py.

Crate mapping (one per platform.yaml concern):

| Contract concern | Crate(s) |
|---|---|
| Async runtime | `tokio` |
| HTTP framework + middleware | `axum`, `tower`, `tower-http` |
| gRPC (interservice sync) | `tonic` |
| Messaging (interservice async) | `async-nats` |
| Structured JSON logging | `tracing`, `tracing-subscriber` (json) |
| Telemetry (traces/metrics) | `opentelemetry`, `opentelemetry-otlp`, `tracing-opentelemetry` |
| OIDC / JWT auth | `jsonwebtoken` + a JWKS fetch/cache (reqwest-based) |
| Persistence | `sqlx` (async, compile-time-checked queries; Postgres) |
| Error model (RFC 9457) | hand-rolled problem+json via `serde` (small, no heavy dep) |
| Config (typed, KEEL_ env) | `serde` + `figment` (or `config`) |
| Serialization | `serde` / `serde_json` |

Hexagonal mapping holds: the domain is pure Rust (no I/O crates), ports are traits,
adapters implement them, and the reference service wires them in a composition root.
SQLx is query-first rather than an ORM, so the ORM-vs-domain-mapping guidance from
ADR-0009 becomes trait-based repositories per aggregate.

### Consequences

- Good: one runtime, tower middleware parity with the Python edge, native OTel,
  compile-time-checked SQL, and a type system that makes deny-by-default and
  exhaustive error handling structural rather than conventional.
- Good: the Rust vertical runs the same behavioral contract-conformance spec
  (ADR-0009 test kit) against its own app, proving the same platform.yaml claims.
- Bad: a second toolchain to maintain; longer compile times in CI.
- Constraint: the dev environment has no local Rust toolchain, so Rust slices are
  verified by the CI lane (cargo fmt/clippy/test/audit), not locally. Slices stay
  small so a CI round-trip is cheap.

## More information

- Tiers and conformance: [ADR-0009](0009-shared-library-vs-generated-code.md).
- Hexagonal architecture: [ADR-0002](0002-hexagonal-architecture.md).
- Python-vertical precedents: [ADR-0013](0013-python-web-framework.md), [ADR-0014](0014-logging-implementation.md).
