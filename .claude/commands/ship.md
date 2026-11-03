---
description: Gate, commit, push, and open a PR into dev for the current branch
---
Ship the current branch's work:

1. Run `/gates`; only proceed if all green.
2. Stage and commit with a **Conventional Commit** message (title = `type(scope): summary`).
   **No `Claude`/`Anthropic`/`Co-Authored-By` trailer.**
3. Push with the gh credential helper:
   `git -c credential.helper= -c credential.helper='!gh auth git-credential' push -u origin <branch>`
4. Open a PR into `dev` (`gh pr create --base dev`) with a filled body: summary, what changed,
   verification, and a checklist (targets dev / conventional title / no emojis / gates green).
5. Update `docs/STATUS.md` and any ADR notes if scope changed.
6. Poll `gh pr checks <n>` until settled; report the result. Fix and repeat if red.

Extra context for this ship: $ARGUMENTS
