# 0023. OpenBao SecretProvider adapter (static KV v2 over the Vault HTTP API)

- **Status:** accepted <!-- proposed | accepted | rejected | deprecated | superseded by ADR-XXXX -->
- **Date:** 2026-11-17
- **Deciders:** keel maintainers

## Context and problem statement

ADR-0007 chose **OpenBao** as the default production `SecretProvider` backend (over HashiCorp
Vault, on BSL-licensing grounds), and `platform.yaml` (`secrets.prod_adapters`) names `vault`
first. Today every vertical ships only the dev `EnvSecretProvider` behind a uniform `SecretProvider`
port (one `get`-style method; Python additionally has `get_optional`). No production backend exists,
so secret material (mTLS PEM, api_key hashes) is injected via environment/Kubernetes Secrets.

v0.7 implements the first production backend to full parity across all five verticals. This ADR
records the concrete realization ADR-0007 left open so the five implementations are consistent
rather than improvised per language. Dynamic database credentials, Transit encryption, and PKI/mTLS
issuance (also anticipated by ADR-0007) are **out of scope here** and remain v0.8 work; this ADR is
static KV read only.

## Decision drivers

- **Full functional parity** - the same backend, protocol, config surface, and semantics in all five verticals.
- **One protocol, five languages** - behavior must be identical by specification, not coincidence.
- **No heavy or unmaintained dependencies** - the surface we need (authenticate, read one KV v2 path) is tiny; several language Vault SDKs are heavyweight or unmaintained.
- **Works against OpenBao and HashiCorp Vault** - both speak the same HTTP API; one adapter must serve either endpoint unchanged.
- **Fail-closed** - once a Vault backend is configured, a service must not silently fall back to reading secrets from the environment.
- **Extracted-repo friendly** - a generated standalone service must build and run with no network codegen or vendor toolchain.

## Decision

1. **Backend: OpenBao, spoken via the Vault KV v2 HTTP API.** The identical wire protocol serves
   OpenBao and HashiCorp Vault, so a single adapter covers both. Env-var naming is `KEEL_VAULT_*`
   (API-oriented; recognizable; endpoint-agnostic).

2. **A thin HTTP client per vertical, not a vendor SDK.** Each vertical implements a small client
   (authenticate + read KV v2) on its existing HTTP stack. No new vault SDK dependency in any
   vertical. The client lives inside the `adapters` module - the sanctioned place to touch a secret
   store (the ADR-0007 semgrep rule bans direct secret-store access elsewhere).

3. **Auth methods: token and Kubernetes.** Token (`KEEL_VAULT_TOKEN`) for local/CI; Kubernetes
   auth (service-account JWT) for production on k8s. No other auth methods in v0.7.

4. **Static KV v2 read, one path, fields as keys.** `get(name)` returns field `name` from the
   secret at `<mount>/<path>`, preserving the flat-key semantics the env adapter already has.

5. **Load-into-cache + background refresh.** The port's `get` is synchronous in every vertical, and
   Node cannot do synchronous HTTP, so `get()` must never perform I/O. The adapter loads the KV
   path's field map into memory once at init and serves `get()` synchronously from that cache; a
   background refresh re-loads every TTL. This keeps one fetch model across all five rather than a
   read-through that only four languages could implement.

6. **Fail-closed selection.** When `KEEL_VAULT_ADDR` is set, the vertical uses the OpenBao adapter;
   a misconfiguration (missing auth, unreachable server, missing path) fails loudly rather than
   silently falling back to the environment. When unset, the `EnvSecretProvider` is used as today.

7. **No contract schema change.** This realizes the already-named `secrets.prod_adapters[0]` slot;
   `contractVersion` stays `0.2.0`.

## Protocol (normative - all five verticals MUST match this)

**Gating.** The OpenBao provider is active iff `KEEL_VAULT_ADDR` is non-empty. Otherwise the
`EnvSecretProvider` is used. There is no silent fallback once `KEEL_VAULT_ADDR` is set.

**Config (all `KEEL_VAULT_*`):**

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `KEEL_VAULT_ADDR` | yes (gates) | - | Base URL, e.g. `https://openbao:8200` |
| `KEEL_VAULT_TOKEN` | one-of auth | - | Static client token |
| `KEEL_VAULT_ROLE` | one-of auth | - | Kubernetes auth role name |
| `KEEL_VAULT_K8S_MOUNT` | no | `kubernetes` | Kubernetes auth mount path |
| `KEEL_VAULT_K8S_JWT_PATH` | no | `/var/run/secrets/kubernetes.io/serviceaccount/token` | Service-account JWT file |
| `KEEL_VAULT_MOUNT` | no | `secret` | KV v2 mount |
| `KEEL_VAULT_PATH` | yes | - | Secret path under the mount |
| `KEEL_VAULT_NAMESPACE` | no | - | `X-Vault-Namespace` header (Vault Enterprise / OpenBao namespaces) |
| `KEEL_VAULT_CACERT` | no | system roots | CA for TLS verification (PEM literal or file path) |
| `KEEL_VAULT_CACHE_TTL_SECONDS` | no | `60` | Field-map cache TTL |

**Authentication.** Resolve a client token in this order:
1. If `KEEL_VAULT_TOKEN` is set, use it directly.
2. Else if `KEEL_VAULT_ROLE` is set, Kubernetes login: `POST {addr}/v1/auth/{k8s_mount}/login`
   with JSON `{"role": <role>, "jwt": <contents of jwt_path>}`; the client token is
   `.auth.client_token` and `.auth.lease_duration` drives renewal.
3. Else fail construction (addr set, no auth configured).

The token is sent as the `X-Vault-Token` header on every request. `X-Vault-Namespace` is sent when
`KEEL_VAULT_NAMESPACE` is set. For `https` addresses, TLS is verified against the system roots or
`KEEL_VAULT_CACERT`.

**Read (KV v2).** `GET {addr}/v1/{mount}/data/{path}`. The field map is the JSON pointer
`.data.data`. `get(name)` returns `fields[name]` if present; a missing field is "absent" with the
port's existing semantics (Python `get` raises `KeyError` / `get_optional` returns `None`; Go/TS
return the not-found signal; Rust returns `None`; Java returns `Optional.empty()`). A `404` at the
path (no secret) yields an empty field map (every `get` is absent), not an error - the same as an
empty env.

**Loading, caching & renewal.** At init the adapter authenticates and loads the field map at
`{mount}/data/{path}` into an in-memory cache; `get()` serves synchronously from that cache and
performs no I/O. A background refresh re-reads the path every `KEEL_VAULT_CACHE_TTL_SECONDS`; on a
`401/403` during refresh the client re-authenticates (Kubernetes re-login; a static token surfaces
the error) and retries once. If a refresh fails, the last good field map continues to be served and
the failure is logged - a transient OpenBao outage does not take the service down. A Kubernetes
lease is renewed by re-login when it nears expiry. In TypeScript, where init is asynchronous, the
adapter exposes an awaited async factory that completes the first load before the provider is used;
in the other four verticals the first load happens eagerly at construction (which may block).

**Errors.** `KEEL_VAULT_ADDR` set but the server is unreachable, auth fails, or `KEEL_VAULT_PATH`
is unset -> the provider fails loudly at construction or first read. No fall-through to the
environment.

## Selection and wiring

A per-vertical factory returns the OpenBao provider when `KEEL_VAULT_ADDR` is set, else the
`EnvSecretProvider`. Java overrides its auto-wired `@ConditionalOnMissingBean SecretProvider` with a
bean conditional on `keel.vault-addr`; the other verticals expose the factory for the service
composition root (mirroring how the env adapter is constructed today). The runtime consumers that
already read through the port (mTLS PEM loading, api_key hashes) transparently gain the backend.

## Testing

- **Unit (non-gated):** each vertical tests its client against an in-process mock HTTP server -
  token and Kubernetes auth, KV v2 read, field-map caching + TTL expiry, 404-as-empty, 403-reauth,
  namespace header, and fail-closed on misconfig. Asserts request shape (paths, headers, bodies)
  and that a known secret value round-trips.
- **Integration (gated on `KEEL_VAULT_ADDR`):** against a real `openbao:2.7.2` dev server (added to
  `deploy/docker-compose.yml` and the CI services), write a KV v2 secret and read it back through
  the adapter, proving end-to-end behavior. Skipped locally without the env var, run in CI -
  mirroring the NATS/Keycloak integration pattern.

## Consequences

- The `vault` production adapter named in `platform.yaml` becomes real in all five verticals; the
  STATUS "secret backends" row moves from "not implemented" to implemented for the OpenBao/Vault
  slot (AWS Secrets Manager and GCP Secret Manager remain later adapters behind the same port).
- Because the client is hand-written and tiny, behavior is uniform and fully mockable, and no
  vertical takes on a vault SDK dependency.
- Dynamic Postgres credentials, Transit, and PKI/mTLS issuance remain future work (v0.8), layered
  on the same client and config surface.
- OpenBao `2.7.2` is pinned as the current stable release (latest-stable policy); the adapter is
  version-agnostic across the KV v2 API so the pin is only the dev/CI server.
