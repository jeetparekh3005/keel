# Implementation status (v0.1)

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
- Edge hardening: security headers (CSP, Permissions-Policy, HSTS over HTTPS), body-size
  limit, an **opt-in** per-instance `RateLimitMiddleware`, and **default-deny CORS**
  (explicit allowed origins only). Request rate limiting is primarily a gateway concern
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
- **Edge hardening**: security headers (nosniff, frame-options, referrer-policy, HSTS) and
  a request body-size limit - header fast-path **and** a streaming byte cap (413).
- **Metrics**: OpenTelemetry `Meter` + HTTP RED middleware, labelled by **route template**
  (bounded cardinality), request count + latency.
- **Port-coverage conformance check**: every driven port in `platform.yaml` must have a
  registered adapter (fails CI otherwise).
- **Postgres integration test** (CI service container) + an 85% coverage floor.
- gRPC is an opt-in extra (`keel-core[grpc]`), not a core dependency of every service.

## Planned - described in the contract/ADRs but NOT yet implemented

| Area | Claimed in | Status |
|------|-----------|--------|
| `api_key` / `mTLS` credential types | platform.yaml auth; ADR-0006 | **Implemented** - `ApiKeyAuthenticator` (hashed keys, X-API-Key over HTTP) and gRPC mTLS credential builders (`mtls_channel_credentials`/`mtls_server_credentials`). Certs are provisioned per-deployment (OpenBao PKI, ADR-0007) |
| Kubernetes **admission** policy (verify signatures at deploy) | ADR-0010 §5 | **Not implemented** - needs the k8s layer (v0.2) |
| **Keycloak / NATS integration tests** | ADR-0010 | **Not implemented** - Postgres integration is wired; Keycloak/NATS still stub/in-memory |
| **Kubernetes/Helm** + runtime `securityContext`, NetworkPolicy | ADR-0004/0008 | **Implemented** - Helm chart at `deploy/charts/reference-service` (non-root, read-only rootfs, drop-all caps, seccomp RuntimeDefault, no SA token, default-deny NetworkPolicy, liveness/readiness probes); lint + kubeconform in CI |
| Base-image **digest pinning** | platform.yaml image; ADR-0008 | **By design, deferred to Renovate** - Chainguard bases are rolling/continuously-rebuilt, so every build is Trivy-scanned instead; static digest pins would freeze stale CVEs. Renovate-managed digests tracked for v0.2 |
| **gRPC IDL/buf**, **Kafka/RabbitMQ** broker adapters | platform.yaml interservice; ADR-0012 | **Partial.** NATS JetStream adapter (`keel-core[nats]`) implemented with trace propagation, held to a shared MessageBus contract; Kafka/RabbitMQ and buf/protobuf IDL still planned. gRPC application auth (deny-by-default) and mTLS credentials are implemented. |

This table shrinks as the gaps close. Track B (the v0.1 review remediation) closed authz,
edge hardening, metrics, graceful shutdown, perf wiring, security CI gates, port-coverage,
and Postgres integration; the remainder is largely v0.2 deployment/edge work.
