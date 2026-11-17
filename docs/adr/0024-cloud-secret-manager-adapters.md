# 0024. AWS Secrets Manager and GCP Secret Manager SecretProvider adapters

- **Status:** accepted <!-- proposed | accepted | rejected | deprecated | superseded by ADR-XXXX -->
- **Date:** 2026-11-17
- **Deciders:** keel maintainers

## Context and problem statement

ADR-0023 shipped the OpenBao/Vault `SecretProvider` backend (the contract's `prod_adapters[0]`)
across all five verticals with a shared model: load a KV path's field map into a cache, serve
`get()` synchronously, refresh in the background, fail closed, never log a secret. `platform.yaml`
`secrets.prod_adapters` also names `aws_secrets_manager` and `gcp_secret_manager`. This ADR
implements those two, reusing the ADR-0023 caching model so a service can source secrets from AWS
Secrets Manager or GCP Secret Manager through the same port with identical semantics.

## Decision drivers

- **Full functional parity** - AWS and GCP behave exactly like OpenBao through the `SecretProvider`
  port (same `get` semantics, coercion, caching, fail-closed, no-leak).
- **Correct, secure cloud auth** - AWS SigV4 request signing and GCP OAuth2/ADC are non-trivial and
  security-sensitive; getting them wrong is a vulnerability.
- **Cloud-native credential chains** - production runs on EKS (IRSA) and GKE (Workload Identity);
  the adapter must pick up those ambient credentials without per-service secrets.
- **No divergent copies** - one caching engine shared by all three backends, not three.

## Decision

1. **Official cloud SDKs, not hand-rolled HTTP.** A deliberate reversal of ADR-0023's thin-client
   rule, which applied to Vault's trivial token-header API. AWS SigV4 and GCP ADC are exactly what
   the SDKs implement correctly, and the SDKs resolve the IRSA / Workload Identity credential chains.
   Per vertical: AWS = boto3 / aws-sdk-go-v2 / aws-sdk-secretsmanager (Rust) / AWS SDK for Java v2 /
   `@aws-sdk/client-secrets-manager`; GCP = google-cloud-secret-manager (Python) /
   cloud.google.com/go/secretmanager (Go) / the google-cloud Rust secret-manager crate /
   `com.google.cloud:google-cloud-secretmanager` (Java) / `@google-cloud/secret-manager`.

2. **One secret = a JSON field map.** A single configured secret holds a JSON object; `get(name)`
   returns field `name`, coerced per ADR-0023 (scalars only; object/array/null absent). Parity with
   the port and the Vault field-map model, and cheap (cloud providers bill per secret).

3. **Shared caching core + per-backend loader.** Extract the ADR-0023 cache/refresh/coercion/no-leak
   engine into a small internal caching provider parameterized by a *loader* that authenticates and
   returns the raw field map. OpenBao, AWS, and GCP are three loaders over one core. OpenBao is
   refactored onto it behavior-preservingly - its existing tests must stay green. Unlike OpenBao,
   AWS/GCP loaders carry no token-lease logic: the SDK refreshes credentials internally; the core
   simply re-invokes the loader every TTL.

4. **Default credential chain.** No keel-managed cloud credentials. AWS uses the default provider
   chain (env, IRSA, instance profile, SSO); GCP uses Application Default Credentials (env,
   Workload Identity, metadata server). Only the secret identity and region/project are configured.

5. **At-most-one backend, fail-closed selection.** At most one of `KEEL_VAULT_ADDR`,
   `KEEL_AWS_SECRET_ID`, `KEEL_GCP_SECRET` may be set; more than one is an ambiguous misconfiguration
   that fails construction. None set -> `EnvSecretProvider`.

6. **No contract schema change.** Realizes `secrets.prod_adapters[1]` and `[2]`; `contractVersion`
   stays `0.2.0`.

## Protocol (normative - all five verticals MUST match)

**Selection.** Count the set gating vars among `KEEL_VAULT_ADDR`, `KEEL_AWS_SECRET_ID`,
`KEEL_GCP_SECRET` (each non-empty after trim). Zero -> `EnvSecretProvider`. Exactly one -> that
backend. Two or more -> fail construction ("multiple secret backends configured").

**Shared cache core.** TTL env var is `KEEL_SECRET_CACHE_TTL_SECONDS` (positive-integer-or-fail,
default 60), used by all three backends; OpenBao migrates from `KEEL_VAULT_CACHE_TTL_SECONDS` to
this shared name (unreleased, so no alias needed). The core loads the field map at init (async
factory in TS; eager elsewhere), serves `get()` with no I/O, refreshes every TTL, serves the last
good map on a failed refresh, and never logs a token or secret value (regression-tested).

**AWS Secrets Manager loader.**
- Config: `KEEL_AWS_SECRET_ID` (gates; secret name or ARN), `KEEL_AWS_REGION` (optional; else the
  SDK's region resolution).
- Load: SDK `GetSecretValue(SecretId=...)`; take `SecretString`. Parse it as a JSON object into the
  field map (ADR-0023 coercion). A `SecretBinary`-only secret or a non-object JSON fails loudly
  (a secret meant to back `get(name)` must be a JSON object of fields). `ResourceNotFoundException`
  -> empty field map (all absent), mirroring Vault's 404-as-empty.
- Credentials: default AWS provider chain.

**GCP Secret Manager loader.**
- Config: `KEEL_GCP_SECRET` (gates; `projects/<project>/secrets/<name>`, or the full
  `.../versions/<v>`), `KEEL_GCP_SECRET_VERSION` (optional; default `latest`).
- Load: SDK `AccessSecretVersion(name=.../versions/<version>)`; take `payload.data` (UTF-8). Parse as
  a JSON object into the field map. `NOT_FOUND` -> empty field map.
- Credentials: Application Default Credentials.

**Errors.** A gating var set but the secret is unreadable (auth failure, permission denied, malformed
non-JSON payload) fails loudly at construction or first load - never falls through to the
environment. (Not-found is empty, not an error - same as Vault/env.)

## Testing

- **AWS unit (non-gated):** stub the SDK (boto3 Stubber, aws-sdk-go-v2 middleware, aws-smithy mocks,
  AWS SDK v2 test client, aws-sdk-client-mock) to return a `GetSecretValue` JSON body; assert the
  field map round-trips, coercion, not-found-as-empty, malformed-payload fail-closed, and the no-leak
  invariant. No network.
- **AWS integration (gated on `KEEL_AWS_SECRET_ID`):** against a LocalStack Secrets Manager container
  (added to the dev stack + CI), create a JSON secret and read it back through the adapter.
- **GCP unit (non-gated):** mock the SDK transport / override the endpoint to a local server (GCP has
  no official emulator); same assertion set.
- **GCP integration (gated on `KEEL_GCP_SECRET` + real ADC):** runs only where real GCP credentials
  and a secret exist; skipped in CI (no emulator). Documented as the one backend without a CI-run
  integration test; its unit coverage is correspondingly thorough.

## Consequences

- The `aws_secrets_manager` and `gcp_secret_manager` adapters named in `platform.yaml` become real;
  the STATUS "secret backends" row moves to fully implemented (all three named prod adapters).
- Each vertical takes a dependency on the AWS and GCP SDKs (gated/optional where the language allows:
  a Rust `aws`/`gcp` feature, an extra in Python/TS, a provided-scope or optional Maven dep). This is
  the justified cost of correct cloud auth.
- The shared caching core removes the three-divergent-copies risk and is where any future backend
  (Azure Key Vault) would plug in.
- Rollout is two waves: AWS first (LocalStack-testable, lands the core refactor), then GCP.
