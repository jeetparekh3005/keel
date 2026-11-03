# 0003. Code comment and docstring strategy

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

Comments rot faster than code and, done badly, actively mislead. keel generates code that is meant to model best practice, so the commenting standard must be explicit and enforced — and it must prevent the common failure mode of narrating the code ("stories in comments") rather than explaining it.

## Decision drivers

- Comments must carry information the code cannot express — nothing more.
- The standard must be mechanically enforceable, not left to taste.
- Long rationale must have a home that is versioned and auditable.

## Decision outcome

**Code says *what* and *how*; comments say *why*.** A comment is justified only when a better name, a type, a smaller function, or a test cannot carry the meaning.

### Rules

**Delete on sight**
- Redundant narration that restates the code (`i += 1  # increment i`).
- Story comments — prose re-explaining a block.
- Commented-out code (lint-forbidden; git is the history).
- Changelog/author comments (that is `git blame`).
- Section-banner comments inside a function — if needed, the function is too big; split it.

**Legitimate comments (the only kinds)**
1. Why-this-not-that — a non-obvious decision.
2. Constraints the code can't show (perf, protocol, ordering, legal).
3. Workarounds — **always** with an issue link.
4. Invariants/preconditions the type system can't encode.
5. Public-API docstrings stating the contract.

**Length**
- Inline comments are **≤ ~2 lines**. Rationale that needs a paragraph goes in an **ADR**, and the code carries a one-line pointer (`# see ADR-0007`). There is deliberately no inline home for long prose.

**Docstrings**
- **Required on the public surface** (exported modules, classes, functions). Private/internal code is exempt unless non-obvious.
- Google style. State behavior, non-obvious args, raised errors, and gotchas — never narrate the body.
- Docstrings feed generated API docs (mkdocstrings).

### Enforcement (per language; Python first)

- Ruff `ERA` (eradicate) — fails CI on commented-out code.
- Ruff `D` (pydocstyle, Google convention) — docstrings on the public surface; private exempt.
- mypy strict — types carry the "what," removing type-describing comments.
- **codespell** — catches typos in code, comments, and docs.
- Review norm: "does this comment say something the code can't?" If not, it is a change request.

### Consequences

- Good: diffs stay readable; comments that survive are high-signal.
- Good: decision rationale is auditable in ADRs, not buried in source.
- Neutral: contributors must write an ADR for non-trivial "why"; this is intended friction.

## More information

- Enforced alongside the [hexagonal architecture](0002-hexagonal-architecture.md).
- Docstring output is published as API reference per [`docs/README.md`](../README.md).
