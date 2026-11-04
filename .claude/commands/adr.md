---
description: Draft the next-numbered ADR (MADR) from the template
---
Create the next sequential ADR in `docs/adr/` by copying `docs/adr/template.md`:

- Number = (highest existing NNNN) + 1, zero-padded; filename `NNNN-kebab-title.md`.
- Fill Context, Decision drivers, Considered options, Decision outcome, Consequences.
- **Tool/vendor selection -> a comparison table** of the candidates; **principle/pattern -> prose**
  pros/cons (no false-precision table).
- Status `accepted` with today's date; cross-link related ADRs and the `platform.yaml` sections.
- If the decision isn't implemented yet, add an "Implementation status" note and update `docs/STATUS.md`.

Decision to record: $ARGUMENTS
