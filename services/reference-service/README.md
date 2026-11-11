# reference-service

A thin FastAPI service built on [`keel-core`](../../packages/keel-core-py/). It exists to **prove the platform contract**: everything cross-cutting (app factory, auth, problem+json, health, logging, tracing, persistence plumbing) comes from `keel-core`, so this service is almost entirely domain code.

## Layout (hexagonal - [ADR-0002](../../docs/adr/0002-hexagonal-architecture.md))

```
reference_service/
  domain/        # Item + ItemRepository port (pure)
  application/   # ItemService use cases
  adapters/
    inbound/http/    # items router (driving)
    outbound/        # SqlItemRepository + ORM record (driven)
  config.py      # ServiceConfig (extends keel-core BaseServiceConfig)
  composition.py # wires adapters -> ports, builds the app
  main.py        # ASGI entrypoint (uvicorn reference_service.main:app)
```

import-linter enforces the same layer rules as `keel-core`: the domain imports no I/O libraries, and depends on the `ItemRepository` port, not SQLAlchemy.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/v1/items` | required | create an item |
| GET | `/v1/items/{id}` | required | fetch an item (404 -> problem+json) |
| GET | `/v1/items` | required | list items |
| GET | `/healthz` `/readyz` | public | liveness / readiness (DB ping) |

Auth is deny-by-default: the items router is mounted with the `Authenticator` dependency, so no endpoint is reachable without a valid Bearer/API-key credential.

## Run the full stack

`deploy/docker-compose.yml` brings up the runnable adapters (Postgres, Keycloak OIDC, OpenTelemetry collector, NATS JetStream) and the service:

```bash
docker compose -f deploy/docker-compose.yml up --build
```

The service image (`Dockerfile`) is hardened per [ADR-0008](../../docs/adr/0008-container-hardening.md): a multi-stage build on a shell-less, non-root Chainguard base, shipping **bytecode only** (source stripped). Config is injected via `KEEL_`-prefixed env (`KEEL_DATABASE_URL`, `KEEL_OIDC_*`, `KEEL_OTLP_ENDPOINT`).

## Migrations

Schema is managed by Alembic (`migrations/`); production runs them before the service starts:

```bash
alembic -c alembic.ini upgrade head
```

## Tests

Run the composed app in-process over `httpx.ASGITransport` with SQLite + a stub authenticator - no external services needed. Conformance tests reuse `keel_core.testkit.contract`; a migration test applies Alembic to a temp SQLite DB. The `platform.yaml` contract is validated against its JSON Schema in `keel-core`.
