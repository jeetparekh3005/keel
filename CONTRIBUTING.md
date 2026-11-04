# Contributing to keel

Thanks for contributing! This document describes the branching model, pull-request flow, and commit conventions. They are enforced by CI, so following them keeps your PRs green.

## Branching model

keel uses a **GitFlow-lite** model:

```
feat/*  chore/*  fix/*  docs/*        <- short-lived work branches
        |
        v  PR (squash merge, Conventional Commit title)
      dev                             <- integration; always green, not released
        |
        v  release PR (merge commit)
      main                            <- released only; every commit is a tagged version
        |
        v  tag vX.Y.Z + CHANGELOG (release-please)
```

- **`main`** — released code only. Every commit corresponds to a tagged, released version. Protected: requires a PR and green required checks; no force-pushes or deletions. The `dev -> main` release PR is a **merge commit** (so release-please sees each conventional commit), so `main` does not enforce linear history; `dev` does. There are **0 required approvals today** (bus factor is 1; revisit when a second maintainer joins — see issue #72). Release PRs are authored by `GITHUB_TOKEN` and therefore run no CI, so they are admin-merged; admin bypass is intentionally left on for that reason.
- **`dev`** — the integration branch. Always green, but not yet released. This is the **default branch** you target with day-to-day PRs.
- **Work branches** — short-lived, branched from `dev`, named `type/short-slug`.

### Branch naming

| Prefix | Use for |
|--------|---------|
| `feat/` | new features |
| `fix/` | bug fixes |
| `chore/` | tooling, deps, config, housekeeping |
| `docs/` | documentation only |

Example: `feat/python-auth-adapter`, `chore/renovate-config`.

## Pull-request flow

1. Branch from `dev`: `git switch dev && git pull && git switch -c feat/my-thing`.
2. Make your change. Keep the PR focused.
3. Open a PR **into `dev`**. The PR **title must be a Conventional Commit** (it becomes the squash-commit message).
4. Required checks must pass. Branch protection enforces the checks (not approvals), so a self-merge is fine once they are green.
5. **Squash-merge** into `dev`.
6. Releases: a **release PR** from `dev` -> `main` is maintained automatically by [release-please](https://github.com/googleapis/release-please). Merging it (as a **merge commit**) tags the version and updates `CHANGELOG.md`.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). Commit messages (and PR titles) must match:

```
<type>(<optional scope>): <description>
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`.

**Scopes** (optional but encouraged): `python`, `ts`, `rust`, `go`, `java`, `ci`, `docs`, `platform`, `auth`, `db`.

Examples:

```
feat(python): add OIDC auth adapter
fix(ci): pin asciidoctor image to a digest
docs(platform): document the error taxonomy contract
```

Breaking changes: add `!` after the type/scope (`feat(platform)!: ...`) or a `BREAKING CHANGE:` footer. This drives a major version bump.

## Architecture decisions

Significant decisions are recorded as ADRs in [`docs/adr/`](docs/adr/) using the [MADR](https://adr.github.io/madr/) format. Copy [`docs/adr/template.md`](docs/adr/template.md) to a new numbered file.

## Local setup

keel is a [uv](https://docs.astral.sh/uv/) workspace. Install uv, then:

```bash
uv sync --all-packages   # venv + all workspace members (incl. dev tools)
pre-commit install       # run fast gates (ruff, codespell, gitleaks, mypy) on commit
```

Run the gates the way CI does before opening a PR:

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy -p keel_core
uv run lint-imports
uv run codespell packages
uv run pytest
```

New Python packages go under `packages/`; services under `services/`. Keep generated/service code thin — cross-cutting behavior belongs in `keel-core-py` (see [ADR-0009](docs/adr/0009-shared-library-vs-generated-code.md)).
