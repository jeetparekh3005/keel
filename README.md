# keel

> The keel every project is built on — a polyglot golden-path bootstrapper with auth, data, logging, observability, security, and CI baked in.

**keel** scaffolds new projects — single services or full monorepos — with the hard parts already done right: authentication, database and migrations, structured logging, a shared error taxonomy, typed configuration, observability, security controls, docs, and CI/CD.

Every generated project implements the same cross-language **contract** (`platform.yaml`), so a Python service, a TypeScript frontend, and a Rust worker all behave consistently — and `keel update` propagates platform improvements back into projects already created.

The goal: go from zero to a secure, observable, deployable service in minutes, not weeks.

---

## Status

🚧 **Early development.** keel is being built vertical-by-vertical. The first anchor is the **Python golden-path** (see the [roadmap](#roadmap)).

## Why keel

Teams re-derive the same "right way" to start a service over and over — and get it subtly wrong each time. keel encodes the organization's golden path **once**, generates it **consistently** across languages, and keeps existing projects **current** through versioned updates.

- **Runnable + swappable adapters** — real working auth/DB/logging/telemetry behind stable interfaces you can swap (OIDC → Auth0, Postgres → MySQL, …).
- **One contract, many languages** — every vertical implements the same `platform.yaml` contract for logging format, error taxonomy, auth, config, and telemetry.
- **Governance baked in** — secret scanning, SBOM, dependency pinning, SAST, security headers, CODEOWNERS, and CI are defaults, not afterthoughts.
- **Updatable** — `keel update` pulls template fixes (including CVE patches) into already-scaffolded projects.

## Roadmap

| Milestone | Scope |
|-----------|-------|
| **v0.1** | Python golden-path vertical (reference contract, runnable) |
| **v0.2** | Monorepo + Next.js frontend |
| **v0.3** | Rust vertical (contract stress-test) |
| **v0.4** | Go & Java verticals |
| **v0.5** | `keel update` + reusable-workflow propagation |

## Documentation

- [Architecture](docs/architecture/) — arc42 architecture documentation
- [Architecture Decisions](docs/adr/) — ADRs (MADR format)
- [Contributing](CONTRIBUTING.md) — branching model, PR flow, commit conventions
- [Security](SECURITY.md) — reporting vulnerabilities

## License

[Apache-2.0](LICENSE) © 2026 Jeet Parekh
