---
description: Refresh the backlog from current visibility (epics, tasks, subtasks)
---
Rebuild the backlog from what is actually visible now (don't invent future detail):

1. Run `/audit` first to ground in current state.
2. For each active milestone, ensure an **epic** tracking issue exists (`/epic`) and links its tasks.
3. For the **near-term** milestone (earliest open), ensure every task issue has a concrete
   `## Subtasks` checklist and a priority label; split anything too large into separate tasks.
4. Ensure every `docs/STATUS.md` "planned" row maps to an open issue — create the missing ones.
5. Leave later milestones **epic-level only** and say so explicitly (detail them when they become
   near-term; over-planning rots).
6. Output the ordered backlog: milestone -> epic -> tasks (with priority) -> subtasks, and name the
   single recommended next item (hand off to `/next`).
