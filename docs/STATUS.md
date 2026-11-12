# Implementation status

The ADRs and `platform.yaml` describe the **target** platform. This file is the honest
record of what the code actually implements today versus what is still **planned**, so the
contract is never read as a promise the code hasn't kept yet. Updated as gaps close.

## Implemented and wired

- Hexagonal architecture, enforced by import-linter (keel-core and the reference service).
- Structured logging: JSON schema, recursive **family-based** key redaction (cookie,
  x-api-key, *_token, client_secret, …) + value scrubbing, reserved-field protection,
  trace correlation, stdlib bridge, non-blocking queue writer, log rate limiting.
- OIDC/JWT **authentication**: RS256, `aud`/`iss`/`exp`/`sub` enforced, JWKS.
- Typed config (pydantic-settings, frozen, fail-fast on type), secrets via `SecretProvider`.
- Persistence: async SQLAlchemy, `Database` + `UnitOfWork` plumbing, Alembic migrations.
  `Repository` ports are service-defined (one per aggregate, mapping ORM<->domain); keel-core
  does not ship a generic repository.
- Distributed **tracing** (OpenTelemetry) with log correlation; gRPC, in-memory MessageBus,
  and a **NATS JetStream** MessageBus adapter (`keel-core[nats]`), all propagating trace context.
- RFC 9457 problem+json (incl. `invalid-params`); health/readiness endpoints.
- Edge hardening: always-on security headers (CSP, nosniff, frame-options DENY,
  referrer-policy, Permissions-Policy, HSTS over HTTPS) and a body-size limit (header
  fast-path plus a streaming byte cap, 413); plus opt-in **default-deny CORS** (explicit
  allowed origins only), an opt-in **trusted-host allow-list**, and an **opt-in**
  per-instance `RateLimitMiddleware`. Request rate limiting is primarily a gateway concern
  (ADR-0005); the in-app limiter is defense-in-depth.
- Graceful shutdown: FastAPI lifespan disposes the DB pool, stops the log writer, and
  flushes traces on SIGTERM.
- Non-blocking app logger (queue writer wired into the request path), `BatchSpanProcessor`
  for production span export, and tunable DB connection pool (size/overflow/timeout/recycle/pre-ping).
- Static enforcement in CI: ruff (incl. bandit `S`), ruff-format, mypy strict, import-linter,
  codespell, deptry, pytest. `platform.yaml` validated against its JSON Schema.
- Security CI gates: dependency CVE scan (pip-audit, blocking), secret scan (gitleaks,
  blocking), **SAST (semgrep, blocking)**, SBOM (CycloneDX, artifact). All workflow actions
  are SHA-pinned.
- Image supply chain: the reference-service image is **built and Trivy-scanned** on every
  image-affecting PR (HIGH/CRITICAL gate); on a release it is **pushed to GHCR, signed with
  keyless cosign, and attested** with SLSA build provenance + an SPDX SBOM.
- **Authorization**, enforced deny-by-default: `require_scopes`/`require_roles` (403 on
  insufficient scope), and a **route-auth conformance check** that fails app startup (and
  a shipped test) if any non-exempt route lacks an auth dependency. JWT verification runs
  off the event loop (threadpool) with a bounded JWKS timeout.
- **Metrics**: a DB connection-pool saturation gauge (`db.client.connection.count`/`.max`) and
  a dropped-log counter (`log.records.dropped`) are emitted (`telemetry/saturation.py`). **HTTP
  request metrics (`http.server.request.duration`, `http.server.active_requests`) are NOT yet
  emitted** - no ASGI/FastAPI OpenTelemetry instrumentation is installed, and `tests/test_metrics.py`
  is a placeholder that asserts the instrument's shape without anything producing it. This is a
  v0.6 parity item across all five verticals (see the parity matrix below).
- **Port-coverage conformance check**: every driven port in `platform.yaml` must have a
  registered adapter (fails CI otherwise).
- **Postgres integration test** (CI service container) + an 85% coverage floor.
- gRPC is an opt-in extra (`keel-core[grpc]`), not a core dependency of every service.
- Frontend workspace (v0.2): a Next.js (App Router, TypeScript) app at `apps/web`, managed
  by pnpm + Turborepo, with its own CI lane (lint/typecheck/test/build, plus a CVE
  audit gate). Unit tests run on vitest + Testing Library. See ADR-0016.
- **Rust vertical (v0.3)**: a second language vertical mirroring the Python one, same
  hexagonal boundaries. Shared library `packages/keel-core-rust` (crate `keel_core`) +
  thin `services/reference-service-rust` in a Cargo workspace (axum + tokio + tower,
  ADR-0017). Implements: RFC 9457 problem+json and typed error taxonomy; typed config
  (figment, `KEEL_`-prefixed, fail-fast); JSON structured logging; edge hardening
  (always-on security headers, body-size limit, request-id, opt-in default-deny CORS);
  OIDC/JWT authentication (RS256, `aud`/`iss`/`exp`/`sub` enforced, JWKS cache over
  reqwest/rustls) with deny-by-default `require_scopes` authorization via an axum
  extractor; sqlx persistence (`Database` + `UnitOfWork`, Postgres in prod / SQLite in
  tests) where a dropped transaction rolls back; `Clock`/`SecretProvider` ports; OpenTelemetry
  tracing with resource attributes and log correlation (optional OTLP export); and a
  reusable behavioral **conformance suite** (`testkit::conformance`) that the reference
  service runs against its composed app. Shipped like the Python vertical: a hardened
  Chainguard-based image (built + Trivy-scanned per PR, signed + SLSA-attested on release)
  and a Helm chart `deploy/charts/reference-service-rust` with the same PSS-restricted
  posture. CI lane (`rust.yml`): `cargo fmt`/`clippy -D warnings`/`test`, with a Postgres
  service for the gated CRUD integration test. The JWKS cache refreshes in the background
  (tolerates IdP key rotation), `/readyz` runs a real dependency check, shutdown is
  graceful (SIGTERM drain + telemetry flush), and a route-auth + scope conformance test
  enforces deny-by-default per route. Structured **log redaction** matches the Python
  vertical for the JSON log sink (family-based key redaction + value scrubbing for
  JWT/bearer/AWS-key/PAN, recursive over event and span fields, with reserved-key
  namespacing). Not yet at Python parity: per-line **log-to-trace correlation**
  (`trace_id`/`span_id` are not emitted on Rust log lines), **redaction of the OTLP
  span-export path** (log-sink redaction does not cover span-field export), HTTP request
  **metrics** instrumentation, a live **Keycloak** JWKS integration test, and the
  messaging/gRPC/`api_key`/`mTLS` surfaces (tracked follow-ups on v0.4).
- **Go vertical (v0.4)**: a third language vertical, same hexagonal boundaries, stdlib-first
  (ADR-0018). Shared library `packages/keel-core-go` (a Cargo-workspace-equivalent `go.work`
  module) + thin `services/reference-service-go` (net/http + go-chi/chi). Implements the full
  contract: typed `KEEL_`-prefixed config (fail-fast); RFC 9457 errors with server-fault
  detail scrubbing; structured JSON logging on `log/slog` with secret redaction and **per-line
  trace correlation**; OpenTelemetry traces; edge hardening (security headers outermost, body
  limit, request-id, deny-by-default CORS) and health probes with a real readiness check;
  **OIDC/JWT auth via go-oidc, whose RemoteKeySet refreshes the JWKS natively** (and accepts
  the Entra `scp`-as-string form); pgx persistence with a unit-of-work; the `Clock`/`SecretProvider`
  ports and a reusable **conformance suite** the reference service runs against its composed app
  (items CRUD verified against real Postgres). Shipped like the others: a hardened Chainguard
  image (Trivy reads the Go binary's embedded module list directly; signed + SLSA-attested on
  release) and a Helm chart with the same PSS-restricted posture. CI lane (`go.yml`): gofmt,
  go vet, staticcheck, go test (with a Postgres service), and **govulncheck as a blocking
  dependency-CVE gate**. Several Rust follow-ups are built in from the start here (native JWKS
  refresh, `scp`-string, log-trace correlation, ReDoS-immune scrubbers, honest `t.Skip`
  integration gating). Not yet: HTTP request metrics and a live Keycloak JWKS test.
- **TypeScript/NestJS vertical (v0.4)**: a fourth language vertical, same hexagonal
  boundaries, deliberately batteries-included (NestJS + DI) as the contrast to the stdlib-first
  Go/Rust services (ADR-0019). Shared library `packages/keel-core-ts` (`@keel/core`) + thin
  `services/reference-service-nest` in the repo-root pnpm workspace. Implements the full
  contract: typed `KEEL_`-prefixed config via **zod** (fail-fast), which also validates request
  DTOs (one typed validator, not class-validator); RFC 9457 errors with server-fault detail
  scrubbing; structured JSON logging on **pino** with family-based secret redaction + value
  scrubbing (JWT/AWS/bearer/PEM/Luhn, written ReDoS-safe) and **per-line trace correlation**;
  OpenTelemetry traces (OTel JS); edge hardening as NestJS middleware (security headers
  outermost, body limit -> 413, request-id, deny-by-default CORS) and health probes with a real
  readiness check; **OIDC/JWT auth via jose, whose createRemoteJWKSet refreshes the JWKS
  natively** (and accepts the Entra `scp`-as-string form); a **structurally deny-by-default**
  global guard (every route needs auth + its scope unless explicitly `@Public`); pg persistence
  with a unit-of-work; the `Clock`/`SecretProvider` ports and a reusable **conformance suite**
  the reference service runs against its composed app (items CRUD verified against real
  Postgres). Shipped like the others: a hardened Chainguard image (Trivy scans the shipped
  `node_modules`; signed + SLSA-attested on release) and a Helm chart with the same
  PSS-restricted posture. CI lane (`nest.yml`): prettier, typescript-eslint (type-checked),
  `tsc`, vitest (with a Postgres service), and **`pnpm audit` as a blocking dependency-CVE
  gate**. TypeScript is pinned to the latest 5.x the toolchain supports (not the 7.x native-port
  compiler, which typescript-eslint and NestJS do not yet support). HTTP request metrics
  (`http.server.request.duration` histogram + `http.server.active_requests` up-down counter,
  labelled by the matched route template) are emitted via a core MetricsInterceptor against a
  globally registered OpenTelemetry MeterProvider (OTLP exporter). Not yet: a live Keycloak JWKS
  test, and JSON-formatting NestJS's own bootstrap log lines (the app/error path already logs
  through the redacting pino logger).
- **Java/Spring Boot vertical (v0.4)**: a fifth language vertical, same hexagonal boundaries,
  the dominant enterprise JVM framework (ADR-0020), where several contract requirements are
  framework-native. Shared library `packages/keel-core-java` (`keel-core`) + thin
  `services/reference-service-java` in a Maven reactor; keel-core ships as a Spring Boot
  **auto-configuration** so the service is wired by just depending on it. Implements the full
  contract: typed, fail-fast `@ConfigurationProperties` bound from the same `KEEL_*` env (an
  EnvironmentPostProcessor bridges them to Spring's own property names); RFC 9457 via Spring's
  `ProblemDetail` with server-fault detail scrubbing; **structured JSON logging** with
  family-based secret redaction + value scrubbing (JWT/AWS/bearer/PEM/Luhn, ReDoS-safe) applied
  through Spring Boot's structured-logging value processor, and **per-line trace correlation**
  (Micrometer Tracing populates `traceId`/`spanId`); OpenTelemetry/OTLP tracing; edge hardening
  as servlet filters (security headers outermost, body limit -> 413, request-id, deny-by-default
  CORS) and health probes with a real readiness check; **OIDC/JWT auth via Spring Security
  resource server**, whose `NimbusJwtDecoder` refreshes the JWKS natively (and a custom
  converter accepts the Entra `scp`-as-string form), **structurally deny-by-default**
  (`anyRequest().authenticated()`) with per-route `@PreAuthorize` scopes; `JdbcClient`
  persistence (thin SQL, not an ORM) with a `SELECT 1` readiness; the `Clock`/`SecretProvider`
  ports and a reusable **conformance suite** (driven over the JDK HttpClient) the reference
  service runs against its composed app (items CRUD verified against real Postgres). Shipped
  like the others: a hardened Chainguard JRE image (Trivy scans the fat jar's bundled deps;
  signed + SLSA-attested on release) and a Helm chart with the same PSS-restricted posture. CI
  lane (`java.yml`): **Spotless (google-java-format)**, JUnit + the Spring Boot conformance test
  (with a Postgres service), an **ArchUnit** hexagonal-layering test, JaCoCo, and **Trivy as the
  blocking dependency-CVE gate**. Java is pinned to **25 LTS** (not the non-LTS 27). Not yet:
  HTTP request metrics beyond Micrometer's defaults, a live Keycloak JWKS test, and a hard
  JaCoCo coverage floor (needs cross-module report-aggregation).

- **Service generator (v0.5, all five verticals; ADR-0021).** A **Copier** template per language
  (`templates/service-<lang>` for python, go, rust, java, ts) scaffolds a new thin service (the
  reference service with its name/aggregate/scopes turned into questions). Custom Jinja delimiters
  avoid colliding with each language's syntax: `<< >>` for Python/Go, and `@< >@` for Rust/Java/TS
  (whose angle generics `Foo<Item>` would make `<< >>` mis-lex, and whose manifests use `[[bin]]` /
  `<tags>` / `${}`). Each is **dogfooded**: CI (`generator.yml`) regenerates every reference service
  from its template and asserts the output is **byte-identical** to the committed tree, so template
  and reference cannot drift (each language's own workflow builds + tests the identical reference).
  The **`keel` CLI** (`packages/keel-cli`) wraps `copier copy`/`copier update` (`keel new --language
  <lang>` / `keel update`) and adds a static, **language-aware** `platform.yaml` conformance check
  (`keel check`: detects the language by build manifest, then checks the keel-core dependency, the
  app factory, typed config, and deny-by-default authz with per-language markers). The **`keel
  update` round-trip** is proven in CI: a test stands up a git-tagged copy of the template, generates
  a service, makes a local edit, advances the template, and asserts `keel update` propagates the
  template change (rendered with the service's answers) while preserving the local edit (ADR-0021
  Tier-2 propagation). **Tier-3 propagation** (issue #32) is in place: a Helm **library chart**
  (`deploy/charts/keel-service-base`) holds the shared hardened manifests and the per-service charts
  depend on it, so a hardening change propagates by a dependency bump (verified: `helm template`
  output is byte-identical before/after). Reusable **`workflow_call` CI workflows**
  (`.github/workflows/service-<lang>.yml`) encapsulate each language's gate and generated services
  ship a `ci.yml` that references them by tag; in-tree the verticals are still covered by the central
  per-language workflows, so the reusable lanes are the mechanism for the polyrepo future (ADR-0011,
  which also needs the keel-core packages published per language).

## Cross-vertical parity matrix (v0.6 target)

Python is the reference vertical. The first LTS requires **full functional parity**: every
capability implemented in every vertical, or explicitly waived. This matrix is the honest,
code-audited current state and the v0.6 target (every non-`full` cell becomes `full`). It is
tracked by epic #419. Legend: `full` = implemented + tested; `partial` = plumbing exists but not
wired to a sink/gate; `none` = absent.

| Capability | Python | Rust | Go | Java | TypeScript |
|------------|--------|------|-----|------|------------|
| HTTP request metrics (`http.server.*`, route-templated) | none* | none | none | none | full |
| Live Keycloak JWKS integration test | full | none | none | none | none |
| Per-line log-to-trace correlation | full | none | full | full | full |
| OTLP span-export redaction | none | none | none | none | none |
| `api_key` authentication (hashed, X-API-Key) | full | none | none | none | none |
| mTLS credentials | full (gRPC) | none | none | none | none |
| NATS JetStream MessageBus adapter | full | none | none | none | none |
| gRPC server (deny-by-default auth + mTLS) | full | none | none | none | none |
| Enforced CI coverage floor | full (85%) | none | none | weak (25/30) | lib-only |
| DB pool saturation metric (emitted, not just readable) | full | partial | partial | partial | partial |
| NestJS bootstrap logs as JSON (TS-only) | n/a | n/a | n/a | n/a | none |

`*` Python's HTTP-request-metrics row was previously described as "done" via FastAPI's native
instrumentation; a code audit found that instrumentation is not installed and the test is a
placeholder, so no vertical emits these today. It is a genuine parity gap, not a regression.

The scope is large by design (the backend-integration surfaces - `api_key`, mTLS, NATS, gRPC -
plus metrics and OTLP-span redaction must reach the four non-Python verticals, and Python needs
HTTP metrics + OTLP-span redaction). Each capability is "one feature, fanned out across the
verticals it is still missing from."

## Planned - described in the contract/ADRs but NOT yet implemented

| Area | Claimed in | Status |
|------|-----------|--------|
| `api_key` / `mTLS` credential types | platform.yaml auth; ADR-0006 | **Implemented** - `ApiKeyAuthenticator` (hashed keys, X-API-Key over HTTP) and gRPC mTLS credential builders (`mtls_channel_credentials`/`mtls_server_credentials`). Certs are provisioned per-deployment (OpenBao PKI, ADR-0007) |
| Kubernetes **admission** policy (verify signatures at deploy) | ADR-0010 §5 | **Not implemented** - cosign verification at admission (Kyverno/policy-controller) is a future milestone; images are signed + attested today |
| **Keycloak / NATS integration tests** | ADR-0010 | **Implemented** - CI integration job runs Postgres, a NATS JetStream container (MessageBus roundtrip), and Keycloak with an imported realm (OIDC authenticate against a real JWKS via client_credentials) |
| **Kubernetes/Helm** + runtime `securityContext`, NetworkPolicy | ADR-0004/0008 | **Implemented** - Helm chart at `deploy/charts/reference-service` (non-root, read-only rootfs, drop-all caps, seccomp RuntimeDefault, no SA token, default-deny NetworkPolicy, liveness/readiness probes); lint + kubeconform in CI |
| Base-image **digest pinning** | platform.yaml image; ADR-0008 | **Deliberately not pinned.** Chainguard bases are rolling/continuously-rebuilt, so every build is Trivy-scanned instead; a static digest pin would freeze stale CVEs. The published image is cosign-signed and attested by its built digest. (No Renovate in this repo; Dependabot covers the github-actions, uv, and npm ecosystems.) |
| **gRPC IDL/buf**, **Kafka/RabbitMQ** broker adapters | platform.yaml interservice; ADR-0012 | **Partial.** NATS JetStream adapter (`keel-core[nats]`) implemented with trace propagation, held to a shared MessageBus contract; Kafka/RabbitMQ and buf/protobuf IDL still planned. gRPC application auth (deny-by-default) and mTLS credentials are implemented. |
| Production **secret backends** (Vault, AWS/GCP secret managers) | platform.yaml `secrets.prod_adapters` | **Not implemented.** The `SecretProvider` port exists with an env-backed adapter (dev). The `vault` / `aws_secrets_manager` / `gcp_secret_manager` production adapters named in the contract are not yet built; deployments inject secrets via env (Kubernetes Secret) today. |

This table shrinks as the gaps close. v0.1 delivered the Python vertical and its review
hardening; v0.2 added the deployment surface (frontend, Helm, image pipeline, brokers,
api_key/mTLS, CORS, IdP/broker integration) and its pre-v0.3 review remediation. What remains
is the remaining per-language verticals (v0.4+) and the items still marked planned above.
v0.3 delivered the **Rust vertical** (library + reference service + image + Helm + CI),
reaching functional parity with the Python vertical except for the follow-ups noted above.
