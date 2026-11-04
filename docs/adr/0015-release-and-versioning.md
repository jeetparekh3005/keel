# 0015. Release management and versioning

- **Status:** accepted
- **Date:** 2026-11-04
- **Deciders:** Jeet Parekh

## Context and problem statement

keel needs a release process and a versioning policy. It is a monorepo (a shared library
`keel-core-py` plus services), and the platform **contract** in `platform.yaml` evolves on its
own cadence. We need to decide what "a version" means, how releases are cut, and how the
contract's compatibility is tracked.

## Decision drivers

- Conventional-commit-driven releases (release-please computes the bump and changelog).
- **Pre-1.0, the repo version tracks milestones**, not individual features: a whole milestone
  (many `feat`s) is one minor bump, so the version stays legible against the roadmap (v0.1, v0.2).
- A clear integration -> release path that matches the branching model (dev -> main).
- Keep the contract's compatibility story separate from the repo's release version.

## Considered options

| Option | Versioning | When |
|---|---|---|
| **Single repo version (release-please)** | one SemVer for the repo | **now** |
| Per-package independent versions | release-please manifest per package | when `keel-core` is published |
| CalVer | date-based | n/a (SemVer fits a library) |

## Decision outcome

- **Repo SemVer via release-please, with a deliberate pre-1.0 milestone lever.** Config sets
  `bump-minor-pre-major` *and* `bump-patch-for-minor-pre-major`, so pre-1.0 a `feat` bumps a
  **patch** and only `!`/`BREAKING CHANGE` bumps the minor. This is intentional: individual
  features accumulate as patches within a milestone, and each **milestone is released as a minor
  via an explicit `Release-As: 0.N.0` footer** on the `dev` -> `main` integration commit (the one
  manual lever, applied by `/release`). That keeps the repo version aligned with the roadmap
  milestone rather than minting a new minor per feature. Post-1.0 this lever is dropped and
  standard `feat` -> minor automation applies.
- **Release path = dev -> main.** Work integrates on `dev`; merging `dev` -> `main` brings the
  conventional commits to `main`, where release-please maintains a release PR. Merging that PR
  tags `vX.Y.Z` and updates `CHANGELOG.md` (see `/release`).
- **The platform `contractVersion` (platform.yaml) is independent** of the repo version. It
  governs cross-language contract compatibility: additive change -> minor, breaking change ->
  major with a documented migration. A service records the `contractVersion` it targets.
  It moved `0.1.0 -> 0.2.0` when the v0.2 milestone added the `http` edge-security
  concept (CORS, security headers, host allow-list) to the contract: additive, so a minor.
- **Publishing is separate from releasing.** Today `keel-core` is consumed in-workspace (and via
  git); publishing to a private index/PyPI and image publishing (cosign/SBOM) are **planned**
  (tracked under v0.2). When `keel-core` is published, revisit per-package versioning.

### Consequences

- Good: zero-touch versioning + changelog; one obvious release lever.
- Good: the contract can evolve and be versioned without churning the repo version.
- Bad: a single repo version means a service-only fix still bumps the whole repo; acceptable
  until packages are published independently.

## More information

- Branching/PR model: [ADR-0011](0011-repository-topology.md), `CONTRIBUTING.md`.
- Implemented-vs-planned (incl. publishing): [docs/STATUS.md](../STATUS.md).
