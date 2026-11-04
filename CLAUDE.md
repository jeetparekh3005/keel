# keel — working agreement

Polyglot golden-path bootstrapper. v0.1 vertical = **Python**: a shared library
(`packages/keel-core-py`) + a thin reference service (`services/reference-service`),
in a uv workspace. Hexagonal: domain is pure; adapters implement the ports defined by
the contract in `platform.yaml`.

## Golden rules (always)
- **No emojis** anywhere in the repo.
- **Never** put `Claude`, `Anthropic`, or a `Co-Authored-By` trailer in a commit message.
- **`docs/STATUS.md` is the source of truth** for implemented-vs-planned. If scope changes,
  update STATUS.md and the relevant ADR note in the same PR. Don't let the contract over-claim.
- **Keep docs current in every PR** (README/STATUS/ADR as relevant).
- Run **all gates green locally before pushing** (`/gates`).

## Workflow
- Branch from `dev`, named `type/short-slug` (`feat/…`, `fix/…`, `chore/…`, `docs/…`).
- PR **title must be a Conventional Commit**. Types: feat, fix, docs, chore, refactor, perf,
  test, build, ci, style, revert. Scopes: python, ts, rust, go, java, ci, docs, platform,
  auth, db, security.
- Squash-merge into `dev`; `dev` -> `main` is the release path (release-please). 0 approvals,
  so self-merge is fine once checks are green.
- Push uses the gh credential helper: `git -c credential.helper= -c credential.helper='!gh auth git-credential' push`.

## Gates (the full local suite — see `/gates`)
```
uv sync --frozen --all-packages
uv run ruff check . && uv run ruff format --check .
uv run mypy -p keel_core -p reference_service
uv run lint-imports
uv run codespell packages
for p in packages/*/ services/*/; do uv run --directory "$p" deptry src; done
uv run pytest --cov=keel_core --cov=reference_service   # 85% floor
```
Integration tests need `KEEL_TEST_DATABASE_URL` (Postgres); they skip otherwise and run in CI.

## Conventions
- **Ports & adapters**: new cross-cutting behavior goes in `keel-core` (Tier 1), not copied
  into services. Services stay thin. Every driven port needs an adapter (enforced by
  `tests/test_port_coverage.py`).
- **Auth is deny-by-default, enforced**: every non-exempt route must carry an auth dependency
  (`require_scopes`/`require_roles`); the startup conformance check fails otherwise.
- **ADRs**: MADR format in `docs/adr/`. Tool/vendor choice -> comparison table; principle -> prose.
- **Comments**: say *why*, not *what*; public-API docstrings required; long rationale -> an ADR.

## Project management & releases
- Planned work is tracked as GitHub issues on milestones **v0.2–v0.5** and the "keel roadmap"
  board. PRs reference the issue they close (`Closes #N`). New planned work -> open an issue first.
- Releases: repo **SemVer via release-please**. Work lands on `dev`; merging `dev` -> `main` lets
  release-please open a release PR that tags the version + updates `CHANGELOG.md` (see `/release`).
- The platform **`contractVersion`** (`platform.yaml`) is versioned independently of the repo (ADR-0015).

## Pointers (read on demand, not auto-loaded)
- Architecture decisions: `docs/adr/` · Contract: `platform.yaml` · Status: `docs/STATUS.md`
- Branching/PR detail: `CONTRIBUTING.md` · Core library: `packages/keel-core-py/README.md`

## Commands
Start a session with **`/audit`** (consistency sweep: drift, open PRs/issues, release due, docs/ADR gaps).
- `/audit` session sweep · `/next` drive the top issue to done (one at a time) · `/backlog` refresh backlog
- `/slice` start a feature slice · `/gates` full suite · `/ship` gate+commit+push+PR · `/review` 3 reviewers
- `/adr` new ADR · `/epic` epic->tasks->subtasks · `/release` cut a release
