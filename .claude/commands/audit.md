---
description: Session consistency sweep — verify nothing is being dropped
---
Read-only audit of project state (run at the start of a session or before a release).
Report a concise table with `[ok]` / `[gap]` / `[action]` per item; do NOT fix anything yet;
end with a prioritized "do next" list.

1. **Git**: current branch; uncommitted changes (`git status`); `dev` vs `main` divergence
   (`git log --oneline main..dev`). Unreleased commits on `dev` mean a release is due (`/release`).
2. **PRs**: open PRs and their checks (`gh pr list`, `gh pr checks <n>`). Any red, stale, or
   unmerged-but-done?
3. **Issues**: open issues by milestone (`gh issue list --json number,title,milestone,labels`).
   Flag issues with no milestone or no priority label; flag work that merged but whose issue
   is still open; flag issues on the board vs not.
4. **Docs drift**:
   - Does `docs/STATUS.md` still match the code? Spot-check both directions: anything marked
     "planned" that is actually implemented, and "implemented" that may have regressed.
   - Any decision in recent commits/PRs with no ADR, or an ADR status note that is now stale?
   - READMEs/ROADMAP current with recent changes?
5. **Gates**: are they green on the current branch? Offer `/gates`; do not auto-run unless asked.
6. **Backlog health**: does each active milestone's epic link its tasks, and does the near-term
   milestone's top task have concrete subtasks and a priority?

Output: a status table + a short prioritized action list. Then ask which to tackle, or suggest `/next`.
