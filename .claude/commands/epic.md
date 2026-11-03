---
description: Create an epic with its task issues and subtask checklists
---
Model work as **epic -> task -> subtask** on GitHub (no native epics, so):
- **Epic** = a tracking issue labeled `epic`, scoped to a milestone, whose body holds a
  `## Tasks` checklist linking its task issues.
- **Task** = a normal issue (type/area/priority labels + milestone); its body has a
  `## Subtasks` checklist.
- **Subtask** = a checklist item in the task. Promote to its own issue only if it needs
  independent tracking.

For the requested epic ($ARGUMENTS):
1. Create/confirm the milestone.
2. Create the epic tracking issue (label `epic`) with a one-line goal + a `## Tasks` checklist.
3. Create each task issue (labels + milestone) with a concrete `## Subtasks` checklist; add each
   to the "keel roadmap" board (`gh project item-add 1 --owner jeetparekh3005 --url ...`).
4. Edit the epic body to link the task issues (`- [ ] #N title`).
5. Report the epic -> tasks -> subtasks tree.

Keep subtasks small and concrete. Do not over-decompose milestones that are not near-term.
