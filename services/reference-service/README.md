# reference-service

A thin FastAPI service built on [`keel-core`](../../packages/keel-core-py/). It exists to **prove the platform contract**: everything cross-cutting (app factory, auth, problem+json, health, logging, tracing, persistence plumbing) comes from `keel-core`, so this service is almost entirely domain code.

## Layout (hexagonal — [ADR-0002](../../docs/adr/0002-hexagonal-architecture.md))

```
reference_service/
  domain/        # Item + ItemRepository port (pure)
  application/   # ItemService use cases
  adapters/
    inbound/http/    # items router (driving)
    outbound/        # SqlItemRepository + ORM record (driven)
  config.py      # ReferenceConfig (extends keel-core BaseServiceConfig)
  composition.py # wires adapters -> ports, builds the app
  main.py        # ASGI entrypoint (uvicorn reference_service.main:app)
```

import-linter enforces the same layer rules as `keel-core`: the domain imports no I/O libraries, and depends on the `ItemRepository` port, not SQLAlchemy.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/items` | required | create an item |
| GET | `/items/{id}` | required | fetch an item (404 → problem+json) |
| GET | `/items` | required | list items |
| GET | `/healthz` `/readyz` | public | liveness / readiness (DB ping) |

Auth is deny-by-default: the items router is mounted with the `Authenticator` dependency, so no endpoint is reachable without a valid Bearer/API-key credential.

## Run

```bash
uv run uvicorn reference_service.main:app   # needs OIDC + DB env (see docker-compose, slice 6b)
```

Tests run the composed app in-process over `httpx.ASGITransport` with SQLite + a stub authenticator — no external services needed.
