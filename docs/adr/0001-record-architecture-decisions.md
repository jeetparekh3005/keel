# 0001. Record architecture decisions

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

keel encodes an organization's golden path across multiple languages. The *why* behind each cross-cutting choice (auth model, error taxonomy, logging format, release strategy) matters as much as the code, and must survive contributor turnover and be auditable.

## Decision drivers

- Decisions must be versioned, reviewable, and discoverable alongside the code.
- Auditors and new contributors need the reasoning, not just the outcome.
- The format must be lightweight enough that people actually write them.

## Considered options

- [MADR](https://adr.github.io/madr/) (Markdown Any Decision Records)
- Nygard-style lightweight ADRs
- A wiki / Confluence page per decision

## Decision outcome

Chosen option: **MADR**, stored as numbered Markdown files in `docs/adr/`.

MADR is structured enough to prompt the important fields (drivers, options, consequences) while staying plain Markdown that reviews in a PR. ADRs live in git as the source of truth; the arc42 "Architecture Decisions" section indexes them rather than duplicating them.

### Consequences

- Good: decisions version with the code and are reviewed like code.
- Good: `docs/adr/` becomes the audit trail.
- Neutral: contributors copy `template.md` to the next number and link related ADRs.

## More information

- ADRs are referenced from arc42 §9 in [`docs/architecture/`](../architecture/).
- Template: [`template.md`](template.md).
