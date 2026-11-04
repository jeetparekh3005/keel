---
description: Pick the single highest-priority open issue and drive it to done
---
Work exactly ONE item end to end (one at a time):

1. **Select** the top open issue: earliest active milestone, highest priority (p0 > p1 > p2),
   not blocked by an open dependency. Show it and confirm before starting.
2. If it needs a design decision, write the ADR first (`/adr`).
3. **Implement** via `/slice`: branch `feat/<slug>` from `dev`, keep it thin, add tests, update
   `docs/STATUS.md` / the relevant ADR / READMEs. The PR references the issue (`Closes #N`).
4. `/gates`, then `/ship`.
5. After the PR is green and merged: confirm the issue closed, the board card moved to Done, and
   the parent epic's checklist item ticked.
6. Report what shipped and what the next item would be. **Stop** - do not start the next item
   without a go.

Optional target issue to work instead of the top one: $ARGUMENTS
