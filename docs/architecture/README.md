# keel architecture (arc42)

This is the arc42 skeleton for keel itself. Sections are **tiered**: the mandatory core is filled first; the rest are stubbed and filled when relevant (arc42's failure mode is empty ceremony — tiering avoids it).

> The cross-language **contract** that every generated vertical implements will live in `platform.yaml` at the repo root, and is described in §5 and §8 once defined.

## Sections

| #  | Section | Tier | Status |
|----|---------|------|--------|
| 1  | Introduction & goals | **core** | stub |
| 2  | Architecture constraints | optional | stub |
| 3  | System scope & context (C4 System Context) | **core** | stub |
| 4  | Solution strategy | optional | stub |
| 5  | Building-block view (C4 Container / Component) | **core** | stub |
| 6  | Runtime view | optional | stub |
| 7  | Deployment view | optional | stub |
| 8  | Cross-cutting concepts (the platform contract) | **core** | stub |
| 9  | Architecture decisions -> [ADRs](../adr/) | **core** | linked |
| 10 | Quality requirements | optional | stub |
| 11 | Risks & technical debt | **core** | stub |
| 12 | Glossary | optional | stub |

## Diagrams

- **Mermaid** for in-repo diagrams that render on GitHub.
- **C4-PlantUML** for the canonical C4 System/Container/Component diagrams.
- Rendered via **Kroki** in CI so diagrams embed identically in HTML, PDF, and Confluence.

## Decisions

Architecture decisions are **not** written here — they are [ADRs](../adr/) in MADR format, indexed from §9.
