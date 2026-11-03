# Contributing to keel

Thanks for contributing! This document describes the branching model, pull-request flow, and commit conventions. They are enforced by CI, so following them keeps your PRs green.

## Branching model

keel uses a **GitFlow-lite** model:

```
feat/*  chore/*  fix/*  docs/*        ← short-lived work branches
        │
        ▼  PR (squash merge, Conventional Commit title)
      dev                             ← integration; always green, not released
        │
        ▼  release PR (merge commit)
      main                            ← released only; every commit is a tagged version
        │
        ▼  tag vX.Y.Z + CHANGELOG (release-please)
```

- **`main`** — released code only. Every commit corresponds to a tagged, released version. Protected: requires a PR, review, green CI, and linear history. No direct pushes.
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
4. CI must pass and (for `main`) a review is required.
5. **Squash-merge** into `dev`.
6. Releases: a **release PR** from `dev` → `main` is maintained automatically by [release-please](https://github.com/googleapis/release-please). Merging it (as a **merge commit**) tags the version and updates `CHANGELOG.md`.

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

> Tooling is added per vertical. For now, contributions are docs, platform contract, and CI. A `pre-commit` config and language toolchains land with the first vertical.
