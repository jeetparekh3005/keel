# keel documentation

| Section | Purpose |
|---------|---------|
| [architecture/](architecture/) | arc42 architecture documentation (structure, context, building blocks) |
| [adr/](adr/) | Architecture Decision Records (MADR format) |

## Documentation model

keel documents the *platform*, not just the code:

- **arc42** provides the architecture-doc skeleton. Sections are tailored - a mandatory core, the rest stubbed.
- **C4** provides the structure diagrams (System Context -> Container -> Component), embedded into the relevant arc42 sections.
- **MADR** ADRs capture decisions; arc42 §9 indexes them rather than duplicating them.

Delivery targets (HTML site, and optionally PDF / Confluence) are decided per project and wired via CI - the git source is always the single source of truth.
