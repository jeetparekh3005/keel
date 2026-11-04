# 0010. Contract enforcement strategy

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

The contract must be *enforced*, not merely documented. The type system alone covers only the structural parts, so we need an explicit, layered strategy that assigns each concern to the earliest/strongest mechanism that can guarantee it.

## Decision drivers

- Prefer the earliest, strongest enforcement available for each concern.
- Where possible, make invalid states **unconstructible** rather than merely forbidden.
- Keep the strategy portable: typed-compiled languages (Rust/Go/Java) can enforce more than Python; the contract is identical, the floor is higher.

## Decision outcome

**Five enforcement layers, applied earliest-first. The design goal is to convert "rules" into "the only available path."**

1. **Types (compiler/mypy strict)** - ports as `Protocol`; the composition root is typed against ports, so wiring a non-conforming adapter fails type-checking. No `Any` leakage; exhaustive enum/union handling (`assert_never`).
2. **Lint / architecture tests** - `import-linter` enforces hexagonal dependency direction (domain must not import adapters); Ruff/semgrep forbid raw SQL and (via `ERA`) commented-out code.
3. **Library-by-construction** - the `keel-core` app factory *requires* an `Authenticator`, exposes only the schema-conformant logger, and permits errors only as taxonomy types. "Forgot auth" cannot be built.
4. **Contract-test suite** - shipped in the `keel-core` test kit; each service runs it against its own adapters to prove port + schema conformance.
5. **CI gates** - coverage floor, security scans (bandit, pip-audit, gitleaks, semgrep, trivy), SBOM, image signing.

Runtime validation (Pydantic at boundaries, config fail-fast) backstops inputs the above cannot see.

### Concern -> layer

| Concern | Enforced by |
|---|---|
| Port conformance | Types (1) |
| Type-safe boundaries / exhaustiveness | Types (1) |
| Hexagonal dependency direction | Lint/arch (2) |
| No raw SQL | Lint (2) |
| Deny-by-default auth | Library-by-construction (3) + arch test |
| Log schema, RFC 9457 errors, telemetry, health | Library-by-construction (3) + contract tests (4) |
| Config typed + fail-fast | Types (1) + runtime (Pydantic) |
| Coverage, security, SBOM, signing | CI (5) |

### Consequences

- Good: most concerns are guaranteed before runtime; many are impossible to violate by construction.
- Good: a drifting service fails its own CI.
- Bad: not everything is enforceable - naming quality, whether an abstraction is appropriate, and domain modeling remain review/ADR concerns. Stated honestly rather than pretended away.

> **Implementation status (v0.1):** wired in CI today - static layers (mypy, ruff incl.
> bandit `S`, import-linter), pytest + 85% coverage floor, **pip-audit** (dependency CVEs),
> **gitleaks** (secret scan), **SBOM** (CycloneDX), the **port-coverage conformance check**,
> and the route-auth conformance check, plus **semgrep** SAST, **trivy** image scan, and
> **cosign** signing + SLSA/SBOM attestation in the image pipeline. Still planned: cluster-side
> signature **admission** verification. See [docs/STATUS.md](../STATUS.md).

## Deterministic enforcement catalogue

Everything mechanizable is mechanized. Architecture, contract-specific, and manifest rules live in their respective ADRs (linked below); this catalogue is the central index plus the generic and meta checks.

### Generic quality (Ruff)

High-signal packs tied to the contract: `T20` (ban `print` -> use the logger), `LOG`/`G` (logging hygiene), `DTZ` (tz-aware UTC datetimes), `ANN` (annotations), `ASYNC` (no blocking in async), `S` (bandit SAST), `TRY`/`B`/`EM`/`RSE` (exception hygiene), `TID` (banned imports), `SLF`, `FBT`, `PT`, `SIM`/`RET`/`C4`/`UP`/`PERF`/`FURB`, `ERA`, `N`/`D`/`I`. Plus `ruff format` and Ruff `banned-api`.

### Distributed to their ADRs

- Hexagonal boundaries (import-linter) - [ADR-0002](0002-hexagonal-architecture.md)
- Comment/docstring rules (Ruff `D`/`ERA`, codespell) - [ADR-0003](0003-code-comment-strategy.md)
- Manifest/IaC hardening (kube-linter, conftest, trivy config) - [ADR-0004](0004-infrastructure-strategy.md)
- Deny-by-default auth (semgrep) - [ADR-0006](0006-identity-and-access.md)
- Secrets via ports, gitleaks - [ADR-0007](0007-secrets-and-pki.md)
- Image hardening (hadolint, trivy, cosign) - [ADR-0008](0008-container-hardening.md)
- proto/OpenAPI/AsyncAPI contracts (buf, spectral) - [ADR-0012](0012-inter-service-communication.md)

### Cross-cutting tooling

`pip-audit`/`osv` (dependency CVEs), `deptry` (unused/missing deps), `vulture` (dead code), `pip-licenses`/`reuse` (license policy), `sqlfluff` (migrations), `actionlint` (workflows), `shellcheck`, `yamllint`, `taplo`, coverage floor.

### Meta - enforce the contract itself

- A **JSON Schema for `platform.yaml`**, validated in CI (the contract cannot be malformed).
- A **port-coverage check**: every driven port in `platform.yaml` must have a registered adapter in the composition root.

### Orchestration

**pre-commit** runs the fast subset locally; the reusable CI workflow runs the full set - identical gates on every service. These configs ship in `keel-core` (see [ADR-0009](0009-shared-library-vs-generated-code.md)), so a scaffolded service inherits them.

## More information

- The library that enforces by construction is defined in [ADR-0009](0009-shared-library-vs-generated-code.md).
- Comment/docstring enforcement: [ADR-0003](0003-code-comment-strategy.md).
