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
- Static enforcement in CI: ruff (incl. bandit `S`), ruff-format, mypy strict, import-linter,
  codespell, deptry, pytest. `platform.yaml` validated against its JSON Schema.

## Planned — described in the contract/ADRs but NOT yet implemented

| Area | Claimed in | Status |
|------|-----------|--------|
| **Metrics** (`Meter` port, metric emission) | platform.yaml telemetry/ports; ADR-0012 | **Not implemented** — only tracing exists |
| **Authorization** (scope/role enforcement, deny-by-default *by construction*) | platform.yaml auth; ADR-0006 | **Not implemented** — only authentication; routes aren't scope-checked |
| `api_key` / `mTLS` credential types | platform.yaml auth; ADR-0006 | **Not implemented** — only JWT works |
| **Graceful shutdown** (lifespan draining) | platform.yaml health | **Not wired** — helpers exist, no lifespan (Track B) |
| **CI security/supply-chain gates**: semgrep, pip-audit, trivy, gitleaks-in-CI, SBOM, cosign | ADR-0010 §5; platform.yaml image.supply_chain | **Not in CI** — only bandit (via ruff) runs; gitleaks is pre-commit only |
| **Port-coverage conformance check** | ADR-0010 | **Not implemented** |
| **Integration tests** (real Postgres/Keycloak/NATS) + coverage floor | ADR-0010 | **Not implemented** — unit/sqlite/stub only |
| **Kubernetes/Helm** + runtime `securityContext`, NetworkPolicy | ADR-0004/0008 | **Not present** — only docker-compose |
| Image **digest pinning** | platform.yaml image; ADR-0008 | **Not done** — Dockerfile uses rolling tags |
| **gRPC IDL/buf**, **NATS/Kafka/RabbitMQ** broker adapters, mTLS-by-default | platform.yaml interservice; ADR-0012 | **Not implemented** — dev-only factories + in-memory bus |
| HTTP edge hardening: security headers, CORS, body-size limit | (gateway, ADR-0005) | **Not implemented** (ADR-0005/APISIX is v0.2) |

See the review-driven remediation order in the project tracker. This table shrinks as Track B lands.
