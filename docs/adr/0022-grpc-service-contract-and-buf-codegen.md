# 0022. gRPC service contract, buf codegen, and cross-vertical mTLS

- **Status:** proposed <!-- proposed | accepted | rejected | deprecated | superseded by ADR-XXXX -->
- **Date:** 2026-11-13
- **Deciders:** keel maintainers

## Context and problem statement

ADR-0012 decided that east-west synchronous calls use gRPC with a protobuf IDL and `buf` for
lint/breaking-change/codegen, and `platform.yaml` (`spec.interservice.sync`) encodes that. The
plumbing exists in Python (`keel_core` ships an OTel-instrumented gRPC server factory with a
deny-by-default auth interceptor and mTLS credential builders) but there is **no concrete
`.proto` service**, and the Rust/Go/Java/TypeScript verticals have no gRPC at all. v0.6 requires
full parity: every vertical must serve a real gRPC service, deny-by-default, over mTLS. This ADR
records the concrete realization decisions that the ADR-0012 direction left open, so the
cross-language implementation is consistent rather than improvised per vertical.

## Decision drivers

- **Full functional parity** - the same gRPC contract, auth posture, and mTLS must land in all five verticals, generated from one source of truth.
- **One contract, five languages** - the IDL is a contract artifact alongside `platform.yaml`; drift between languages must be impossible by construction.
- **Deny-by-default, re-verified at the service** - a gRPC method is closed unless a scope opens it; the service re-verifies the token (never trusts the gateway), matching the REST posture (ADR-0006).
- **Extracted-repo / polyrepo future** - a generated standalone service must build without a live buf toolchain or network codegen step (ADR-0011).
- **No drift between the reference service and its template** - the generator dogfood must stay byte-identical (ADR-0021).

## Considered options

### A. What the reference gRPC service exposes

- **A1. A read+write slice of the existing aggregate** - an `ItemService` with `GetItem`/`ListItems` (scope `items:read`) and `CreateItem` (scope `items:write`), over the same domain the REST API serves. Demonstrates deny-by-default at per-method granularity with a realistic payload.
- **A2. A dedicated minimal service** - a trivial `Echo`/health method. Smaller, but does not exercise scoped authorization or domain mapping, so it proves less.

### B. Codegen strategy

- **B1. Commit generated stubs per language** - `buf generate` writes language stubs into each `keel-core-<lang>`; they are committed and a CI dogfood asserts `buf generate` reproduces them byte-identically. Consumers (incl. extracted repos) need no buf toolchain.
- **B2. Generate at build time** - no generated code in the tree; every build/consumer runs buf + plugins. Cleaner tree, but every extracted repo and every build needs the toolchain and network.

### C. buf module layout

- **C1. One root `proto/` module** - a single `buf.yaml` + `buf.gen.yaml` at the repo root; one `keel.reference.v1` package; per-language plugin outputs fan into each vertical. `buf lint` + `buf breaking` (against `main`) run in CI.
- **C2. Per-vertical proto copies** - each vertical owns its proto. Rejected on its face: it reintroduces exactly the cross-language drift the IDL exists to prevent.

### D. mTLS

- gRPC server + client credentials per language built from a cert/key/CA sourced from config / the `SecretProvider`, with certs provisioned per deployment by the OpenBao/Vault PKI (ADR-0007). Server requires client auth (mutual); the HTTP edge stays TLS-terminated at the gateway (gRPC is never exposed at the browser edge, ADR-0012).

## Decision outcome

Chosen: **A1 + B1 + C1 + D.**

1. **Contract (A1):** one protobuf package `keel.reference.v1` with an `ItemService` exposing `GetItem`, `ListItems` (require `items:read`) and `CreateItem` (require `items:write`), mapping to the same domain the REST aggregate serves. Scope requirements are declared per method (a method option or a central map, see below) so the deny-by-default interceptor can enforce them uniformly across languages. *(Package/service names are proposed here for review; they are not yet implemented.)*
2. **Codegen (B1):** a root `proto/` buf module; `buf generate` emits committed stubs into each `keel-core-<lang>`; a `generator.yml`-style dogfood asserts regeneration is byte-identical (the same discipline as the template dogfood). Extracted repos ship the committed stubs and need no buf toolchain.
3. **Pipeline (C1):** `buf lint` and `buf breaking` (vs `main`) gate every PR touching `proto/`; the published contract is a versioned artifact (`keel.reference.v1`), breaking changes require a new version package.
4. **Server + authZ:** each `keel-core-<lang>` ships a gRPC server factory that installs the deny-by-default auth interceptor by construction (a servicer cannot be exposed unauthenticated), re-verifies the Bearer token via the existing `Authenticator`, enforces per-method scopes (`UNAUTHENTICATED` / `PERMISSION_DENIED`), and is OTel-instrumented - matching the Python factory.
5. **mTLS (D):** server + client mTLS credential builders per language; certs from config/`SecretProvider` (OpenBao PKI per deployment).

### Consequences

- Good: one IDL is the single source of truth; five languages cannot drift; the contract joins `platform.yaml` as a versioned artifact; deny-by-default + mTLS parity is demonstrable end to end.
- Bad: adds a codegen pipeline and the discipline of regenerating + committing stubs on every proto change; the committed generated code adds review noise (mitigated by the byte-identical dogfood making drift a hard CI failure).
- Neutral: closes the v0.6 `mTLS` and `gRPC server` parity rows; sets up the v0.7 Kafka/RabbitMQ + AsyncAPI work (the same contract-artifact discipline) and the v0.9 publishing (the generated stubs ship inside each `keel-core-<lang>`).

## More information

- Supersedes nothing; **realizes** ADR-0012 (inter-service communication) and depends on ADR-0006 (identity/access, deny-by-default) and ADR-0007 (secrets/PKI for the mTLS certs).
- Contract sections: `platform.yaml` `spec.interservice.sync` (transport=grpc, idl=protobuf, tooling=buf) and `spec.auth` (mtls credential type, deny-by-default).
- Tracked by epic #419 (v0.6 parity); the gRPC/mTLS rows of the `docs/STATUS.md` parity matrix close when this lands in all five verticals.
