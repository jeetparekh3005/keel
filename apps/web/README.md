# @keel/web

The Next.js frontend of the keel monorepo (App Router, TypeScript). Managed by
pnpm + Turborepo from the repo root.

## Develop

```sh
pnpm install
pnpm --filter @keel/web dev     # http://localhost:3000
```

## Checks (what CI runs)

```sh
pnpm lint        # next lint (eslint-config-next)
pnpm typecheck   # tsc --noEmit
pnpm build       # next build
```

This app is the starting surface for the platform's web UI; feature UIs build on
top of it and call the backend through the API gateway.
