# 0018. Go vertical stack

- **Status:** accepted
- **Date:** 2026-11-10
- **Deciders:** Jeet Parekh

## Context and problem statement

v0.4 adds a third language vertical: `keel-core-go` plus a thin reference service
that satisfies the same [`platform.yaml`](../../platform.yaml) contract as the
Python (ADR-0013/0014) and Rust (ADR-0017) verticals, under the same tier model
(ADR-0009) and hexagonal boundaries (ADR-0002). As with Rust, building the vertical
must not require changing the contract; the conformance suite is the spec. We need
to choose the module layout, HTTP stack, and the library for each contract concern,
all from the mature, actively-maintained, OSS tier, and all idiomatic Go.

## Decision drivers

- Satisfy every `platform.yaml` concern (logging, errors, http edge, auth, telemetry,
  persistence, health, interservice) with first-class, well-maintained libraries.
- Stdlib-first and minimal, matching keel's taste: no heavyweight framework owns the
  app. Prefer the standard library where it is now good enough (`log/slog`, `net/http`,
  `database/sql`-adjacent drivers, `context`).
- A middleware model that lets the HTTP edge concerns (security headers, body limit,
  CORS, request-id) compose the way the Python ASGI and Rust tower stacks do.
- Learn from the Rust vertical: the JWKS cache must refresh on key rotation out of the
  box, and structured logs must redact secrets. Pick libraries that give these for free.

## Decision

A root `go.work` ties two modules, mirroring the Cargo workspace:

- `packages/keel-core-go` (module `github.com/jeetparekh3005/keel/packages/keel-core-go`):
  Tier-1 shared library (ports, cross-cutting adapters, test kit, conformance suite).
- `services/reference-service-go` (module `.../services/reference-service-go`): the
  thin reference service that imports the core and implements one aggregate.

Per-concern choices:

| Concern | Choice | Why |
|---------|--------|-----|
| HTTP routing | `net/http` + `github.com/go-chi/chi/v5` | Idiomatic, minimal; a thin router over stdlib handlers. Middleware composes as `func(http.Handler) http.Handler`, matching the edge model of the other verticals. |
| Edge middleware | hand-written `chi` middleware | Security headers, body limit, request-id, deny-by-default CORS, built directly so behaviour matches the contract and the other verticals exactly. |
| Config | `github.com/caarlos0/env/v11` | Struct-tag, typed, `KEEL_`-prefixed env loading; fail-fast on missing/invalid. |
| Logging | stdlib `log/slog` (JSON handler) + a redacting `slog.Handler` | Structured JSON logging in the stdlib; a wrapping handler applies the same family-key redaction and value scrubbing as the Python and Rust verticals. |
| Errors | hand-written taxonomy + RFC 9457 `Problem` | One `DomainError` category per failure, mapped to status and a `urn:keel:error:*` type, rendered as `application/problem+json`; server-fault detail is never leaked. |
| Auth | `github.com/coreos/go-oidc/v3` | `oidc.NewRemoteKeySet` fetches and caches JWKS and refreshes on rotation natively (the gap we had to hand-fix in Rust), with RS256 verification of `aud`/`iss`/`exp`/`sub`. Deny-by-default authz enforced by a middleware + scope checks. |
| Persistence | `github.com/jackc/pgx/v5` + `pgxpool` | The idiomatic high-performance Postgres driver. A `Database` + `UnitOfWork` where an unfinished transaction rolls back, matching the other verticals. Postgres in prod and tests. |
| Telemetry | `go.opentelemetry.io/otel` + OTLP (`otlptracegrpc`) + `otelslog` | Native OpenTelemetry traces with a shared resource; `otelslog` bridges `slog` to span context for log correlation. |
| Health | stdlib handlers | `/healthz` liveness and `/readyz` readiness with an injected dependency (DB ping) check. |
| Tests | stdlib `testing` + `testcontainers-go` | Table-driven unit tests; Postgres and Keycloak integration tests gated behind an env var, like the other verticals. |
| Static analysis | `gofmt`, `go vet`, `staticcheck`, `govulncheck` | The Go CI lane; `govulncheck` is the dependency-CVE gate (the Go-native equivalent of pip-audit/cargo-audit). |

## Consequences

- A third vertical proves the contract is genuinely language-agnostic, and stdlib-first
  Go keeps the surface small.
- `go-oidc`'s remote key set removes the manual JWKS-refresh code the Rust vertical
  needed, and `log/slog` gives structured logging without a third-party logger; only the
  redaction layer is bespoke (shared design with the other verticals).
- `govulncheck` replaces the "no Go dependency-CVE gate" risk before it exists.
- Java (ADR to follow) is the remaining v0.4 vertical.
