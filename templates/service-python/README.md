# keel Python service template

A [Copier](https://copier.readthedocs.io) template that scaffolds a new keel **Python** service:
a thin FastAPI service built on `keel-core-py`, already wired for the full `platform.yaml`
contract (deny-by-default auth, RFC 9457 errors, structured redacting logs, OTel tracing, edge
hardening, OIDC/JWT, persistence, conformance suite). It is the reference service with its
service-specific identifiers turned into questions (ADR-0021, ADR-0009 Tier 2).

## Generate a service (`keel new`)

```sh
# with the keel CLI (packages/keel-cli):
keel new orders-service --language python \
  -d service_name="Orders Service" \
  -d aggregate=order

# or invoke Copier directly:
uvx copier copy --trust \
  --data service_name="Orders Service" \
  --data aggregate=order \
  path/to/keel/templates/service-python  orders-service
```

Questions:

| Answer | Example | Drives |
|--------|---------|--------|
| `service_name` | `Orders Service` | human name; defaults the slug |
| `service_slug` | `orders-service` | directory, Python package, image, chart |
| `aggregate` | `order` | the domain aggregate (singular, snake_case) |
| `aggregate_plural` | `orders` | routes (`/v1/orders`), table, scope prefix |
| `scope_prefix` | `orders` | OAuth scopes (`orders:read` / `orders:write`) |

The generated service depends on `keel-core` **by version** (a uv-workspace dependency in-tree;
a published-package dependency once split to its own repo), so platform fixes arrive as a
dependency bump (ADR-0009 Tier 1) while template/boilerplate fixes arrive via `keel update`.

## Propagate template changes (`keel update`)

The generated service commits a `.copier-answers.yml` recording the template version + answers.
To pull forward later template fixes without clobbering local edits:

```sh
keel update orders-service        # or: cd orders-service && uvx copier update --trust
```

## Maintaining the template

The template is the **source of truth**; CI regenerates the reference service from it and runs
its full suite (the dogfood test, issue #370), so the template and the working reference service
cannot drift. Custom Jinja delimiters (`<< >>`, `<% %>`) are used so Python's own braces
(f-strings like `f"{order_id}"`) never collide with templating.
