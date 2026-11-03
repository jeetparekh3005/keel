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

1. **Types (compiler/mypy strict)** — ports as `Protocol`; the composition root is typed against ports, so wiring a non-conforming adapter fails type-checking. No `Any` leakage; exhaustive enum/union handling (`assert_never`).
2. **Lint / architecture tests** — `import-linter` enforces hexagonal dependency direction (domain must not import adapters); Ruff/semgrep forbid raw SQL and (via `ERA`) commented-out code.
3. **Library-by-construction** — the `keel-core` app factory *requires* an `Authenticator`, exposes only the schema-conformant logger, and permits errors only as taxonomy types. "Forgot auth" cannot be built.
4. **Contract-test suite** — shipped in the `keel-core` test kit; each service runs it against its own adapters to prove port + schema conformance.
5. **CI gates** — coverage floor, security scans (bandit, pip-audit, gitleaks, semgrep, trivy), SBOM, image signing.

Runtime validation (Pydantic at boundaries, config fail-fast) backstops inputs the above cannot see.

### Concern → layer

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
- Bad: not everything is enforceable — naming quality, whether an abstraction is appropriate, and domain modeling remain review/ADR concerns. Stated honestly rather than pretended away.

## More information

- The library that enforces by construction is defined in [ADR-0009](0009-shared-library-vs-generated-code.md).
- Comment/docstring enforcement: [ADR-0003](0003-code-comment-strategy.md).
