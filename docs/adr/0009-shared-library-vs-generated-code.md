# 0009. Shared library vs generated code

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

keel must keep many services consistent and let platform fixes (e.g. a CVE in the auth adapter) reach every service with minimal effort. We need an explicit rule for what is a shared dependency vs what is generated-and-owned vs what is referenced infrastructure.

## Decision drivers

- Fix-once, propagate-everywhere for cross-cutting behavior.
- Consistency across services by construction, not by discipline.
- Keep generated, team-owned code thin so `keel update` has little to migrate.

## Decision outcome

**Three tiers, with the explicit goal of maximizing Tier 1 and minimizing Tier 2.**

### Tier 1 - `keel-core-<lang>` (shared, versioned library; a dependency, never copied)

The actual platform. Holds everything identical across services:
- Port **interfaces** (the contract as code).
- Cross-cutting **adapters**: structured logger, OTel setup, RFC 9457 error handler + exception types, Pydantic config base, health endpoints, the app factory wiring middleware (auth, request-id, tracing, errors), OIDC `Authenticator`, `SecretProvider` adapters, `Repository` base + unit-of-work.
- **Test kit**: a fake for every port + the contract-test suite services run against their own adapters.

One `keel-core-<lang>` per language; all implement the same [`platform.yaml`](../../platform.yaml) contract.

### Tier 2 - generated per service (scaffolded once, owned by the team)

Kept thin: domain models, use cases, service-specific routers/adapters, migrations, the composition root wiring, config values.

### Tier 3 - infrastructure / CI (shared by reference, not copied)

Reusable CI workflows (`uses: org/keel/...@v1`) and a base Helm chart the service chart depends on.

### Decision rule

| If it is… | …it lives in | …and updates via |
|---|---|---|
| Same for every service, fix-once-propagate | **Tier 1 library** | version bump (Dependabot) |
| Structure/boilerplate a team customizes | **Tier 2 template** | `keel update` diff |
| Cross-cutting, non-code | **Tier 3 workflow/chart** | tag/chart version |

A CVE in the auth adapter is a `keel-core` version bump - not N per-service edits.

### Consequences

- Good: N services share one implementation of each concern; consistency is structural.
- Good: the thin Tier 2 keeps `keel update` migrations small.
- Bad: library versioning/compat discipline is now required (semver, deprecation windows).
- Neutral: per-language cores must be kept in contract-lockstep (enforced per [ADR-0010](0010-enforcement-strategy.md)).

## More information

- Repository layout for these tiers: [ADR-0011](0011-repository-topology.md).
- The Python vertical (#6) delivers `keel-core-py` + a thin reference service on top of it.
