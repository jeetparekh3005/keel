# ADR-0021: Service generator (Copier) and `keel update` propagation

- Status: accepted
- Date: 2026-11-11
- Deciders: platform team
- Relates to: ADR-0009 (shared library vs generated code), ADR-0011 (repository topology)

## Context

ADR-0009 defines three tiers. Tier 1 (`keel-core-<lang>`, the shared versioned libraries) is
delivered for all five languages (v0.1-v0.4). This ADR records how **Tier 2** (the thin,
team-owned per-service code) is **scaffolded** and kept up to date, and how **Tier 3**
(reusable CI + a base Helm chart) propagates - the v0.5 milestone.

Two distinct propagation channels must not be conflated:

- **Tier 1 (library) changes** - a CVE fix in the auth adapter, a new port - reach a service as
  a **dependency version bump** (Dependabot), with no code migration. This already works.
- **Tier 2 (template/boilerplate) changes** - the shape of the composition root, a new config
  field, a CI wiring tweak - must reach *already-generated* services without clobbering the
  team's edits. This is the gap v0.5 closes.

## Decision

### Generator: Copier, dogfooded from the reference service

Use **Copier** (not cookiecutter): Copier's first-class `copier update` is exactly the Tier-2
propagation channel we need - cookiecutter can only generate, not update. The template for each
language lives at `templates/service-<lang>/` and is the reference service with the
service-specific values (name, aggregate, port, scopes, DB) turned into Copier questions
(`copier.yml`). The generated service depends on `keel-core-<lang>` **by version** and stays
thin per ADR-0009.

**The template is dogfooded**: CI regenerates `services/reference-service` from
`templates/service-python/` and asserts the result builds and passes the conformance suite, so
the template can never drift from the known-good reference.

### `keel new service` and `keel update`

- `keel new service` -> `copier copy` the template into a new service (a new repo is the real
  use case, ADR-0011; in-tree generation is supported for the dogfood test).
- `keel update` -> `copier update`: re-apply the template at a newer tag and 3-way-merge
  template changes into the generated service, preserving team edits. A `.copier-answers.yml`
  committed in the generated service records the template version + answers.

### The `keel` CLI: a thin wrapper

A small **Python** CLI (Copier is Python; the CLI dogfoods the Python ecosystem) wrapping
`copier copy` / `copier update`, plus keel-specific value: friendly prompts, and a
**`platform.yaml` conformance check** (validate a service's scopes/error-types/config against
the contract after generation/update). Not a from-scratch CLI: Copier does the templating; keel
adds validation and UX. Richer subcommands (`doctor`, `list`, pinning policy) are deferred.

### Language order

**Python first** (most mature reference; Copier-native), proving `new` + `update` end-to-end,
then Go/Rust/TS/Java templates reuse the proven mechanism.

### v0.5 sequencing

The **generator (#31)** lands first (the core bootstrapper value), then **Tier 3 (#32)** -
reusable CI workflows (`uses: jeetparekh3005/keel/.github/workflows/service-<lang>.yml@v1`) and
a base Helm chart the service charts depend on.

## Consequences

- A team scaffolds a conformant, hardened, CVE-gated service in one command, and `keel update`
  pulls template/CI fixes forward - the project finally *bootstraps* rather than demonstrates.
- The library-bump vs template-update split keeps most fixes to a Dependabot bump; only
  boilerplate-shaped changes need a `keel update` diff (ADR-0009's thin Tier 2 keeps those small).
- The dogfood CI makes the template self-verifying: a reference-service change that is not
  reflected in the template fails CI, so template and reference stay in lockstep.
- Cost: Copier/Jinja templating adds a markup layer over the reference source (mitigated by
  dogfooding, which keeps the rendered output honest); one template per language to maintain.
- Works in the polyrepo future (ADR-0011): generated services in their own repos update via
  `copier update` + the Tier-3 tag bumps, no monorepo required.
