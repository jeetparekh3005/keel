# Roadmap

Milestones are tracked on GitHub (Issues -> Milestones) and the **keel roadmap** project board.
This file is a human-readable mirror; the issues are the source of truth.

| Milestone | Theme | Status |
|-----------|-------|--------|
| **v0.1** | Python golden-path vertical: `keel-core-py` + reference service (+ audit hardening) | **released** ([v0.1.3](https://github.com/jeetparekh3005/keel/releases/tag/v0.1.3)) |
| **v0.2** | Frontend monorepo (Next.js) + deployment: k8s/Helm, image publish pipeline, brokers, api_key/mTLS, CORS, IdP/broker integration tests | **released** ([v0.2.0](https://github.com/jeetparekh3005/keel/releases/tag/v0.2.0)) |
| **v0.3** | Rust vertical (the contract stress-test) | **released** ([v0.3.0](https://github.com/jeetparekh3005/keel/releases/tag/v0.3.0)) |
| **v0.4** | Go & Java verticals | in progress (Go vertical landed; Java next) |
| **v0.5** | Copier generator (`keel new service`) + `keel update` propagation + reusable workflows | planned |

See [docs/STATUS.md](docs/STATUS.md) for implemented-vs-planned detail, and the
milestone issues for the concrete work items. Releases follow [ADR-0015](docs/adr/0015-release-and-versioning.md).
