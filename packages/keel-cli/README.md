# keel-cli

The `keel` command: a thin [Copier](https://copier.readthedocs.io) wrapper that scaffolds and
maintains keel services, plus a static `platform.yaml` conformance check (ADR-0021). Copier does
the templating; keel adds friendly entry points and a fast gate. It is deliberately not a
from-scratch generator.

## Commands

```sh
# Scaffold a new service (copier copy), then check it
keel new orders-service --language python -d service_name="Orders Service" -d aggregate=order

# Pull later template fixes into an existing service (copier update)
keel update orders-service

# Statically check a service against the platform contract
keel check orders-service
```

`keel new` and `keel update` run the conformance check automatically afterwards.

## What `keel check` verifies

Static, dependency-free checks that a **thin** service is wired to the platform, run against the
nearest `platform.yaml` (override with `--contract`):

| Check | Meaning |
|-------|---------|
| `contract` | `platform.yaml` resolves and is an `apiVersion` this CLI understands |
| `template-tracked` | `.copier-answers.yml` present, so `keel update` can propagate template fixes |
| `keel-core-dependency` | depends on `keel-core`, the Tier-1 library the guarantees ride on |
| `app-factory` | builds its app with keel-core's `create_app` (health, RFC 9457 errors, edge hardening) |
| `typed-config` | config extends `BaseServiceConfig` (`KEEL_` env prefix, fail-fast, reject-unknown) |
| `deny-by-default-authz` | routes carry `require_scopes` / `require_roles` |

These confirm the service *uses* the platform; the behavioural guarantees themselves (endpoint
shapes, error bodies, redaction, the runtime deny-by-default startup check) are owned and tested
by keel-core and by the service's own `tests/test_conformance.py`. `keel check` is a fast wiring
gate, not a replacement for that suite.
