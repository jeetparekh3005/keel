# ADR-0019: TypeScript/NestJS backend vertical stack

- Status: accepted
- Date: 2026-11-11
- Deciders: platform team
- Supersedes: none

## Context

keel ships one cross-language contract (`platform.yaml`) implemented by per-language
verticals. v0.1 delivered Python, v0.3 Rust, and the first half of v0.4 Go. This ADR
records the stack for the **TypeScript/Node backend vertical**.

The repo already contains TypeScript: the v0.2 Next.js frontend (`apps/web`, ADR-0016).
That is a browser app, not a contract-implementing backend. The tagline advertises services
across TypeScript, so TypeScript needs a backend vertical that implements the same ports as
the Python/Rust/Go services: typed config, RFC 9457 errors, redacting structured logging,
OpenTelemetry tracing with log correlation, edge hardening, OIDC/JWT auth with deny-by-default
authorization, Postgres persistence with a unit of work, and the behavioral conformance suite.

The Go and Rust verticals are deliberately **stdlib-first** (net/http, axum). This vertical is
the deliberate contrast: a **batteries-included, dependency-injected framework** (NestJS), so
the contract is proven against both ends of the ecosystem. If the ports survive both a
hand-wired stdlib service and an opinionated DI framework, the contract is framework-neutral.

## Decision

Build `packages/keel-core-ts` (npm package `@keel/core`) + a thin
`services/reference-service-nest`, in the existing repo-root pnpm workspace (the JS analog of
`go.work` tying the Go modules). The service is a NestJS application; the shared library holds
all cross-cutting behavior as NestJS-native providers, guards, interceptors, filters, and
middleware, so services stay thin (ADR-0009 Tier 1).

### Stack

| Concern | Choice | Why |
|---------|--------|-----|
| Framework | **NestJS 12** (platform-express) | Batteries-included DI framework; the contrast to stdlib-first Go/Rust. Express adapter for maximum middleware/ecosystem compatibility. |
| Language | **TypeScript 5.9** (not 7.x) | See "TypeScript version" below. |
| Config + validation | **zod 4** | One schema library for typed `KEEL_`-prefixed config *and* request DTOs. Deliberately not `class-validator`/`class-transformer`: a single, explicit, inferred-type validator over decorator-reflection. |
| Logging | **pino 10** | Fastest JSON logger for Node; one line per event. Family-based key redaction + value scrubbing are implemented on top (pino's path-based `redact` is not enough to match the other verticals). |
| Tracing | **OpenTelemetry JS** (`@opentelemetry/sdk-node` + OTLP gRPC exporter) | Same OTLP wire format as the other verticals; a pino mixin stamps `trace_id`/`span_id` from the active span (log-to-trace correlation). |
| Auth | **jose 6** (`createRemoteJWKSet` + `jwtVerify`) | `createRemoteJWKSet` fetches, caches, and refreshes the JWKS natively (including on an unknown `kid`), the same property that made `go-oidc`'s `RemoteKeySet` the right Go choice: signing-key rotation is tolerated without a restart. |
| Persistence | **pg (node-postgres) 8** | The de-facto Postgres driver. A `Pool` is `Database`; a pooled client in a transaction is the `UnitOfWork`. Services define their own repository per aggregate (ADR-0009). |
| IDs | **`node:crypto` `randomUUID`** | Built in; no dependency. |
| Tests | **vitest 5** + `unplugin-swc` | One test runner repo-wide (the frontend already uses vitest). SWC compiles the tests so NestJS decorator metadata (`emitDecoratorMetadata`) is emitted, which esbuild alone does not do. |
| Lint/format | **typescript-eslint 8** (type-checked) + **prettier 3** | Static gate analogous to `gofmt`/`clippy` and `ruff`. |
| Supply chain | **`pnpm audit --audit-level high`** (blocking) + image Trivy scan | `pnpm audit` is the dependency-CVE gate (the JS analog of govulncheck/pip-audit); Trivy scans the shipped container's `node_modules` for good measure. |

### TypeScript version

The newest published TypeScript is **7.0.2** (the native-port compiler). It is **not** adopted
here: `typescript-eslint` 8.72 declares `typescript >=4.8.4 <6.1.0` as its supported range, so
the lint gate would reject TS 7, and NestJS 12 has not validated against the native port. The
newest TypeScript the whole toolchain supports is **5.9.3**, which is what this vertical pins.
Revisit when `typescript-eslint` and NestJS publish TS 7 support. This follows the repo's
standing rule: track the latest **stable** version the ecosystem actually supports, not the
latest tag regardless of compatibility.

### Module system

The library and service compile to **CommonJS** (NestJS's supported default; decorators +
`reflect-metadata` need `experimentalDecorators`/`emitDecoratorMetadata`). `jose` 6 is
ESM-only, which is fine: Node's `require(ESM)` for synchronous modules is unflagged on the
Node 24 runtime this repo targets (`.nvmrc`), so a CommonJS service can import it directly.

## Consequences

- A fourth vertical reuses the same contract, ports, and conformance assertions, now proven
  against a DI framework as well as stdlib services.
- Rust/Go follow-ups are built in from the start: native JWKS refresh (jose), the Entra
  `scp`-as-string form, per-line log-to-trace correlation, ReDoS-safe scrubbers (the JS regex
  engine can backtrack, so the scrubber patterns are written to be linear and bounded), and
  server-fault detail scrubbing.
- Not at parity initially (tracked follow-ups, same as the Go vertical): HTTP request
  **metrics** instrumentation and a live **Keycloak** JWKS integration test.
- The pnpm workspace now spans a frontend app and a backend app; CI lanes are filtered per
  package so a backend change does not run under the frontend lane and vice versa.
