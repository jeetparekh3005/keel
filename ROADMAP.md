# Roadmap

Milestones are tracked on GitHub (Issues → Milestones) and the **keel roadmap** project board.
This file is a human-readable mirror; the issues are the source of truth.

| Milestone | Theme | Status |
|-----------|-------|--------|
| **v0.1** | Python golden-path vertical: `keel-core-py` + reference service | **done** (pending release cut) |
| **v0.2** | Frontend monorepo (Next.js) + deployment: k8s/Helm, image publish pipeline, brokers, api_key/mTLS, CORS, IdP/broker integration tests | planned |
| **v0.3** | Rust vertical (the contract stress-test) | planned |
| **v0.4** | Go & Java verticals | planned |
| **v0.5** | Copier generator (`keel new service`) + `keel update` propagation + reusable workflows | planned |

See [docs/STATUS.md](docs/STATUS.md) for implemented-vs-planned detail within v0.1, and the
milestone issues for the concrete work items. Releases follow [ADR-0015](docs/adr/0015-release-and-versioning.md).
