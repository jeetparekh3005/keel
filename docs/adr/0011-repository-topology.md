# 0011. Repository topology

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

`keel-core` and the services built on it need a home. The choice (one repo vs many) affects how fast platform changes propagate, how refactors happen, and how teams take ownership.

## Decision drivers

- Fast, atomic propagation of `keel-core` changes while the platform is young and churning.
- Low ceremony for the first several services.
- A clear path to independent ownership/release cadence later.

## Considered options

| Option | Atomic cross-cutting change | Propagation | Ownership isolation | Ceremony |
|---|---|---|---|---|
| **Monorepo (uv workspace)** | Yes (one PR) | Instant (local package) | Weaker | Low |
| Polyrepo + private index | No (version + bump N) | Via release + Renovate | Strong | High |
| Hybrid (core repo + service repos) | Partial | Via release | Strong | Medium |

## Decision outcome

Chosen option: **monorepo-first (uv workspace)**, with `keel-core-<lang>` and the initial services as workspace members. Split to polyrepo + a private package index only when a boundary demands it.

### Split criteria (when to leave the monorepo)

- A service needs an independent **release cadence** or **compliance boundary**.
- A distinct **team** must own access/CODEOWNERS in isolation.
- CI time or repo size becomes a drag despite caching/affected-only builds.

Until then, the monorepo gives one-PR refactors across `keel-core` and every consumer, instant propagation (no publish step), and a single CI.

### Consequences

- Good: platform changes land atomically with their consumers while things churn.
- Good: `keel-core` is dogfooded by real services in the same tree.
- Bad: weaker ownership isolation; mitigated by CODEOWNERS per package and affected-only CI.
- Neutral: the eventual polyrepo split is a known, criteria-driven migration, not a surprise.

## More information

- Tiers that populate the workspace: [ADR-0009](0009-shared-library-vs-generated-code.md).
- `keel update` and reusable workflows make propagation work in the polyrepo future too.
