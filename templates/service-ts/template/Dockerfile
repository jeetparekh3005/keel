# syntax=docker/dockerfile:1
# Hardened image per ADR-0008 for the TypeScript/NestJS vertical. Build context is the repo
# root (the pnpm workspace). Base images use rolling Chainguard tags by deliberate choice
# (scanned every build; ADR-0008). Trivy scans the shipped node_modules for known CVEs.

FROM cgr.dev/chainguard/node:latest-dev AS build
WORKDIR /app
USER root
ENV CI=true
RUN corepack enable

# Install with a cached layer: only the workspace manifests change less often than source.
# A filtered install pulls just the backend subtree (the service + @keel/core), not the
# frontend app, even though its manifest is present so the workspace graph resolves.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/keel-core-ts/package.json packages/keel-core-ts/package.json
COPY services/@< service_slug >@/package.json services/@< service_slug >@/package.json
RUN pnpm install --frozen-lockfile --filter @< service_slug >@...

# Build the library and the service, then produce a self-contained prod bundle (the service
# plus its workspace dependency, prod deps only) that the runtime stage can run directly.
COPY packages/keel-core-ts packages/keel-core-ts
COPY services/@< service_slug >@ services/@< service_slug >@
RUN pnpm --filter @keel/core build \
  && pnpm --filter @< service_slug >@ build \
  && pnpm --filter @< service_slug >@ deploy --prod --legacy /app/out

FROM cgr.dev/chainguard/node:latest
WORKDIR /app
COPY --from=build /app/out /app
EXPOSE 8000
ENTRYPOINT ["node", "dist/main.js"]
