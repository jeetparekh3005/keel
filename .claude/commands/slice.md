---
description: Start a new vertical/feature slice as a thin, gated PR
---
Start a new slice:

1. `git switch dev && git pull`, then branch `feat/<slug>` from `dev`.
2. Implement $ARGUMENTS. Keep it thin and focused — cross-cutting behavior belongs in
   `keel-core`, not the service. Follow the hexagonal layering and the port contract.
3. Add/extend tests (unit + contract; integration if it touches persistence/auth).
4. Keep `docs/STATUS.md`, the relevant ADR, and READMEs current.
5. Run `/gates`, then `/ship`.

Prefer several small gated PRs over one large one. If this needs a design decision, write an
ADR first (`/adr`).
