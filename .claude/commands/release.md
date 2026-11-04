---
description: Cut a release via the dev -> main + release-please flow
---
Cut a release (ADR-0015):

1. Confirm `dev` is green and all intended PRs are merged into it.
2. Open a PR from `dev` into `main` (a **merge commit**, to preserve the conventional-commit
   history release-please reads). Title: `chore(release): dev -> main`.
3. Merge it. release-please then opens/updates a **release PR on `main`** with the computed
   version bump and `CHANGELOG.md` entries.
4. Review the proposed version + changelog, then merge the release PR - this tags `vX.Y.Z`
   and publishes the GitHub release.
5. Verify: `gh release list` shows the new tag; `.release-please-manifest.json` advanced.

Do not hand-edit versions or `CHANGELOG.md` - release-please owns them. Package/image publishing
is a separate pipeline (planned, v0.2).

Target version intent / notes: $ARGUMENTS
