# 0016. Frontend stack and monorepo tooling

- **Status:** accepted
- **Date:** 2026-11-04
- **Deciders:** Jeet Parekh

## Context and problem statement

keel needs a web frontend in the monorepo (v0.2). It must coexist with the Python
uv workspace at the repo root, build and type-check in CI as its own lane, and be
a thin client of the backend (calling the reference service through the API
gateway), not a place where business rules leak back in. We need to choose both a
frontend framework and a JavaScript/TypeScript monorepo tool.

## Decision drivers

- TypeScript-first with strong typing at the data boundary.
- Server-side rendering / React Server Components for a fast, SEO-friendly shell.
- Large talent pool and long-term maintenance; first-class tooling (lint, build).
- Monorepo tool that caches tasks, is low-ceremony, and coexists with uv/Python.
- Must run as an isolated CI lane (Node/pnpm) without disturbing the Python gates.

## Considered options

### Framework

| Framework | SSR / RSC | TypeScript | Ecosystem | Notes |
|---|---|---|---|---|
| **Next.js (App Router)** | Yes (RSC) | First-class | Largest | De-facto standard; Vercel + broad community |
| Remix / React Router 7 | Yes | First-class | Growing | Web-standards focus; smaller ecosystem |
| SvelteKit | Yes | Good | Smaller | Not React; smaller talent pool |
| Plain React + Vite | SPA only | First-class | Large | No SSR/RSC out of the box |

### Monorepo tool

| Tool | Task cache | Ceremony | Coexists with uv | Notes |
|---|---|---|---|---|
| **Turborepo** | Yes (local + remote) | Low | Yes | Config-light; pairs with pnpm workspaces |
| Nx | Yes | Higher | Yes | Powerful but heavier, plugin-centric |
| pnpm workspaces only | No | Lowest | Yes | No task graph/caching |

## Decision outcome

Chosen: **Next.js (App Router, TypeScript) managed by Turborepo over pnpm
workspaces.** The app lives at `apps/web`; the pnpm/Turborepo workspace is rooted
at the repo root alongside `pyproject.toml`, and a dedicated Frontend CI lane runs
`pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`, plus a `pnpm audit`
CVE gate. Unit tests use vitest + Testing Library (jsdom), co-located as
`*.test.tsx`. The tsconfig enables the stricter `noUncheckedIndexedAccess`,
`noImplicitOverride`, and `exactOptionalPropertyTypes` before real UI lands. Node
is pinned via `.nvmrc`.

The frontend is a driving adapter in spirit: it consumes the backend contract and
holds no domain logic, mirroring the hexagonal stance of the Python vertical
(ADR-0002, ADR-0013).

### Consequences

- Good: largest React ecosystem and talent pool; RSC-ready; cached builds.
- Good: the Node toolchain is fully isolated from the Python gates (separate lane).
- Bad: a second toolchain (Node/pnpm) to maintain and keep pinned.
- Bad: Next.js has a faster release cadence than the backend; version bumps need
  deliberate review (Dependabot covers the npm ecosystem).

## More information

- Hexagonal stance: [ADR-0002](0002-hexagonal-architecture.md); backend analog:
  [ADR-0013](0013-python-web-framework.md). Status detail: [docs/STATUS.md](../STATUS.md).
