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

- Automated, conventional-commit-driven releases (no manual version bumping).
- A clear integration → release path that matches the branching model (dev → main).
- Keep the contract's compatibility story separate from the repo's release version.

## Considered options

| Option | Versioning | When |
|---|---|---|
| **Single repo version (release-please)** | one SemVer for the repo | **now** |
| Per-package independent versions | release-please manifest per package | when `keel-core` is published |
| CalVer | date-based | n/a (SemVer fits a library) |

## Decision outcome

- **Repo SemVer via release-please.** Conventional commits drive the bump (`feat` → minor,
  `fix` → patch, `!`/`BREAKING CHANGE` → major). Pre-1.0 uses `bump-minor-pre-major`, so breaking
  changes bump the minor until we reach 1.0.
- **Release path = dev → main.** Work integrates on `dev`; merging `dev` → `main` brings the
  conventional commits to `main`, where release-please maintains a release PR. Merging that PR
  tags `vX.Y.Z` and updates `CHANGELOG.md` (see `/release`).
- **The platform `contractVersion` (platform.yaml) is independent** of the repo version. It
  governs cross-language contract compatibility: additive change → minor, breaking change →
  major with a documented migration. A service records the `contractVersion` it targets.
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
