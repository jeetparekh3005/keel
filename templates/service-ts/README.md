# keel TypeScript (NestJS) service template

A [Copier](https://copier.readthedocs.io) template that scaffolds a new keel **TypeScript** service:
a thin [NestJS](https://nestjs.com) service built on `@keel/core`, wired for the full
`platform.yaml` contract (deny-by-default auth, RFC 9457 errors, structured logs, OTel tracing,
edge hardening, OIDC/JWT, Postgres persistence, conformance suite). It is the reference service
with its service-specific identifiers turned into questions (ADR-0021, ADR-0009 Tier 2).

## Generate a service (`keel new`)

```sh
keel new orders-service --language ts \
  -d service_slug=orders-service \
  -d aggregate=order
```

Questions:

| Answer | Example | Drives |
|--------|---------|--------|
| `service_slug` | `orders-service` | directory, package name, `SERVICE_NAME` default, image |
| `aggregate` | `order` | the domain aggregate (singular); drives the record, service, repository |
| `aggregate_plural` | `orders` | routes (`/v1/orders`), table, module/file names, scope prefix |
| `scope_prefix` | `orders` | OAuth scopes (`orders:read` / `orders:write`) |

The generated service depends on `@keel/core` as a workspace/package dependency, so platform fixes
arrive as a dependency bump (ADR-0009 Tier 1) while template/boilerplate fixes arrive via
`keel update`.

## Propagate template changes (`keel update`)

```sh
keel update orders-service        # or: cd orders-service && uvx copier update --trust
```

## Maintaining the template

The template is the **source of truth**; CI regenerates the reference service from it and asserts
the output is byte-identical (the dogfood test), so the template and the working reference service
cannot drift. Delimiters `@< >@` are used: TS angle generics (`Array<Item>`) put a `<` right before
the aggregate, so `<< >>` would mis-lex; the `@` prefix never abuts TS type syntax, `${}` template
literals, or decorators (`@Name`), so it is collision-free.
