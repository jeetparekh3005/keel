# Implementation status (v0.1)

The ADRs and `platform.yaml` describe the **target** platform. This file is the honest
record of what the code actually implements today versus what is still **planned**, so the
contract is never read as a promise the code hasn't kept yet. Updated as gaps close.

## Implemented and wired

- Hexagonal architecture, enforced by import-linter (keel-core and the reference service).
- Structured logging: JSON schema, recursive redaction + value scrubbing, reserved-field
  protection, trace correlation, stdlib bridge, non-blocking queue writer, rate limiting.
- OIDC/JWT **authentication**: RS256, `aud`/`iss`/`exp`/`sub` enforced, JWKS.
- Typed config (pydantic-settings, frozen, fail-fast on type), secrets via `SecretProvider`.
- Persistence: async SQLAlchemy, `Repository` port, unit-of-work, Alembic migrations.
- Distributed **tracing** (OpenTelemetry) with log correlation; gRPC + in-memory MessageBus
  factories with trace propagation.
- RFC 9457 problem+json; health/readiness endpoints.
- Graceful shutdown: FastAPI lifespan disposes the DB pool, stops the log writer, and
  flushes traces on SIGTERM.
- Non-blocking app logger (queue writer wired into the request path), `BatchSpanProcessor`
  for production span export, and tunable DB connection pool (size/overflow/timeout/recycle/pre-ping).
- Static enforcement in CI: ruff (incl. bandit `S`), ruff-format, mypy strict, import-linter,
  codespell, deptry, pytest. `platform.yaml` validated against its JSON Schema.
- Security CI gates: dependency CVE scan (pip-audit), secret scan (gitleaks), SBOM
  (CycloneDX) — see `.github/workflows/security.yml`.
- **Authorization**: `require_scopes`/`require_roles` dependencies (403 on insufficient
  scope); the reference service enforces per-route scopes.
- **Edge hardening**: security headers (nosniff, frame-options, referrer-policy, HSTS) and
  a request body-size limit (413 before any handling).
- **Metrics**: OpenTelemetry `Meter` setup + HTTP RED middleware (request count + latency).
- **Port-coverage conformance check**: every driven port in `platform.yaml` must have a
  registered adapter (fails CI otherwise).
- **Postgres integration test** (CI service container) + an 85% coverage floor.
- gRPC is an opt-in extra (`keel-core[grpc]`), not a core dependency of every service.

## Planned — described in the contract/ADRs but NOT yet implemented

| Area | Claimed in | Status |
|------|-----------|--------|
| `api_key` / `mTLS` credential types | platform.yaml auth; ADR-0006 | **Not implemented** — only JWT bearer works |
| **Remaining supply-chain gates**: trivy image scan, cosign signing + admission, semgrep ruleset | ADR-0010 §5; platform.yaml image.supply_chain | **Partial** — pip-audit/gitleaks/SBOM in CI; trivy/cosign are image-build-time (v0.2 publish pipeline); semgrep deferred |
| **Keycloak / NATS integration tests** | ADR-0010 | **Not implemented** — Postgres integration is wired; Keycloak/NATS still stub/in-memory |
| **Kubernetes/Helm** + runtime `securityContext`, NetworkPolicy | ADR-0004/0008 | **Not present** — only docker-compose |
| Image **digest pinning** | platform.yaml image; ADR-0008 | **Not done** — Dockerfile uses rolling tags (needs Renovate + registry) |
| **gRPC IDL/buf**, **NATS/Kafka/RabbitMQ** broker adapters, mTLS-by-default | platform.yaml interservice; ADR-0012 | **Not implemented** — dev-only factories + in-memory bus |
| **CORS** policy (per-service) | ADR-0005 | **Not implemented** — security headers + body-limit are done; CORS is per-service config |

This table shrinks as the gaps close. Track B (the v0.1 review remediation) closed authz,
edge hardening, metrics, graceful shutdown, perf wiring, security CI gates, port-coverage,
and Postgres integration; the remainder is largely v0.2 deployment/edge work.
