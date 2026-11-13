# Roadmap

Milestones are tracked on GitHub (Issues -> Milestones) and the **keel roadmap** project board.
This file is a human-readable mirror; the issues are the source of truth.

| Milestone | Theme | Status |
|-----------|-------|--------|
| **v0.1** | Python golden-path vertical: `keel-core-py` + reference service (+ audit hardening) | **released** ([v0.1.3](https://github.com/jeetparekh3005/keel/releases/tag/v0.1.3)) |
| **v0.2** | Frontend monorepo (Next.js) + deployment: k8s/Helm, image publish pipeline, brokers, api_key/mTLS, CORS, IdP/broker integration tests | **released** ([v0.2.0](https://github.com/jeetparekh3005/keel/releases/tag/v0.2.0)) |
| **v0.3** | Rust vertical (the contract stress-test) | **released** ([v0.3.0](https://github.com/jeetparekh3005/keel/releases/tag/v0.3.0)) |
| **v0.4** | Go, Java, and TypeScript (NestJS) backend verticals | **released** ([v0.4.0](https://github.com/jeetparekh3005/keel/releases/tag/v0.4.0)) |
| **v0.5** | Copier generator (`keel new service`) + `keel update` propagation + reusable workflows + base Helm chart | **released** ([v0.5.3](https://github.com/jeetparekh3005/keel/releases/tag/v0.5.3)) |
| **v0.6** | Cross-vertical **parity closure** | **released** ([v0.6.0](https://github.com/jeetparekh3005/keel/releases/tag/v0.6.0)) |
| **v0.7** | Production **secret backends** + **messaging** breadth | planned |
| **v0.8** | **Supply-chain + deploy** completion | planned |
| **v0.9** | **Publishing** + generator hardening | planned |
| **v1.0 (LTS)** | **Contract freeze** + adoption docs + support policy | planned |

See [docs/STATUS.md](docs/STATUS.md) for implemented-vs-planned detail, and the
milestone issues for the concrete work items. Releases follow [ADR-0015](docs/adr/0015-release-and-versioning.md).

## Path to the first LTS (v1.0)

The first LTS is a contract people can build on for years. Reaching it requires four things to
be true, not just mostly-true, and the v0.6 to v1.0 milestones each close one slice:

1. **The contract is frozen and complete** - promote `keel.dev/v1alpha1` to `v1` and
   `contractVersion` to `1.0.0`, with a written compatibility/deprecation policy. A contract with
   "planned, not implemented" holes cannot be frozen, so **everything the contract names is
   implemented before 1.0** (no de-scoping).
2. **Full functional parity across all five verticals** - every vertical (Python, Rust, Go, Java,
   TypeScript) implements every contract capability, verified by one shared parity matrix with zero
   "not yet" rows.
3. **A generated service is usable standalone** - `keel new` produces a service depending on a
   *published* keel-core (PyPI, crates.io, npm, Maven Central, Go tag), extractable to its own repo,
   proven in CI.
4. **Adoption docs and an LTS support policy exist.**

| Milestone | Exit criteria (the gate) |
|-----------|--------------------------|
| **v0.6 - Parity closure** | One parity matrix in STATUS with zero "not yet" rows. HTTP request metrics and a live Keycloak JWKS test in all five; Rust per-line log-to-trace correlation + OTLP span-export redaction; Java JaCoCo floor; TS bootstrap-log JSON. The already-partial surfaces (api_key/mTLS, NATS messaging, gRPC) brought to all five. Closes #228, #229. |
| **v0.7 - Secret backends + messaging** | Vault / AWS / GCP `SecretProvider` adapters; Kafka + RabbitMQ `MessageBus` adapters; buf/protobuf gRPC IDL. Each implemented across all five verticals (full parity). The secret + broker rows of the STATUS "planned" table become Implemented. |
| **v0.8 - Supply-chain + deploy** | Kubernetes admission policy (cosign/Kyverno) that verifies the image signatures + SLSA attestations keel already produces, blocking unverified images at deploy; OpenBao/Vault PKI wired end-to-end for api_key/mTLS cert provisioning. |
| **v0.9 - Publishing + generator hardening** | keel-core published per language; `keel new` depends on the published package, not a workspace path; templates proven against non-item aggregates AND an extracted standalone repo in CI (builds + tests + deploys). |
| **v1.0 (LTS) - Freeze + docs** | `keel.dev/v1`, `contractVersion 1.0.0` + a compatibility/deprecation ADR; adoption docs (getting-started, per-language, contract reference, security posture, upgrade); LTS support policy; a final full-matrix conformance audit. No "planned" holes remain. |

v0.6 to v0.8 are largely independent; v0.9 (publishing) follows parity + contract-completeness so it
is not published against a moving target; v1.0 is strictly last because it *is* the freeze.
