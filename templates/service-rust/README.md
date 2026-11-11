# keel Rust service template

A [Copier](https://copier.readthedocs.io) template that scaffolds a new keel **Rust** service: a
thin [axum](https://github.com/tokio-rs/axum) service built on `keel-core-rust`, wired for the full
`platform.yaml` contract (deny-by-default auth, RFC 9457 errors, structured logs, OTel tracing,
edge hardening, OIDC/JWT, Postgres persistence, conformance suite). It is the reference service
with its service-specific identifiers turned into questions (ADR-0021, ADR-0009 Tier 2).

## Generate a service (`keel new`)

```sh
keel new orders-service --language rust \
  -d service_slug=orders-service \
  -d aggregate=order
```

Questions:

| Answer | Example | Drives |
|--------|---------|--------|
| `service_slug` | `orders-service` | directory, Cargo package name (crate is the snake form), image |
| `service_name` | `orders-service` | the compiled binary, `service_name` default |
| `aggregate` | `order` | the domain aggregate (singular) |
| `aggregate_plural` | `orders` | routes (`/v1/orders`), table, scope prefix |
| `scope_prefix` | `orders` | OAuth scopes (`orders:read` / `orders:write`) |

The generated service depends on `keel-core-rust` as a crate, so platform fixes arrive as a
dependency bump (ADR-0009 Tier 1) while template/boilerplate fixes arrive via `keel update`.

## Propagate template changes (`keel update`)

```sh
keel update orders-service        # or: cd orders-service && uvx copier update --trust
```

## Maintaining the template

The template is the **source of truth**; CI regenerates the reference service from it and asserts
the output is byte-identical (the dogfood test), so the template and the working reference service
cannot drift. Jinja delimiters `@< >@` are used: Rust angle generics (`Vec<Item>`) put a `<` right
before the aggregate, so `<< >>` would mis-lex, and Cargo.toml's `[[bin]]` collides with `[[ ]]` -
the `@` prefix never abuts Rust type syntax or TOML table headers, so it is collision-free.
