# 0007. Secrets management and PKI

- **Status:** accepted (implementation targeted for v0.2)
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

Services must obtain secrets (DB credentials, API keys, signing keys) and, for mTLS, certificates — without secrets living in source, config, or logs, and without long-lived static credentials. The solution must be open-source and cloud-agnostic.

## Decision drivers

- Truly OSS (the HashiCorp originals are now BSL — see [ADR-0004](0004-infrastructure-strategy.md)).
- Eliminate long-lived static secrets where possible.
- Fit the `SecretProvider` port and the Kubernetes deployment model.

## Considered options

| Option | Dynamic secrets | PKI | License / posture | Cloud-agnostic |
|---|---|---|---|---|
| **OpenBao** | Yes | Yes | MPL-2.0 (Linux Foundation fork of Vault) | Yes |
| HashiCorp Vault | Yes | Yes | BSL 1.1 (source-available) | Yes |
| Cloud secret managers | Limited | Via cloud CA | Proprietary (AWS/GCP/Azure) | No (lock-in) |
| Sealed Secrets / SOPS | No | No | OSS, lightweight | Yes |

## Decision outcome

Chosen option: **OpenBao as the default `SecretProvider` adapter.**

### Capabilities used

- **Static KV** — configuration secrets.
- **Dynamic secrets** — short-lived, per-request **Postgres credentials**, so no static DB password exists.
- **PKI** — an internal CA issuing short-lived certs for **mTLS** between services (used by [ADR-0006](0006-identity-and-access.md)).
- **Transit** — encryption-as-a-service for app-layer encryption.

### Integration

- **Kubernetes:** the **External Secrets Operator** syncs OpenBao -> k8s Secrets, or workloads read directly via the SDK behind the `SecretProvider` port. OpenBao auth via the Kubernetes auth method (service-account JWT).
- **Local dev:** `.env` (gitignored) is the dev `SecretProvider`; an OpenBao dev container is optional for parity.
- Cloud secret managers (AWS SM, GCP SM, Azure Key Vault) are later adapters behind the same port.

### Consequences

- Good: dynamic DB creds + PKI remove whole classes of secret-leak and rotation risk.
- Good: fully OSS and portable.
- Bad: OpenBao is a stateful component to operate (HA, auto-unseal, backups).
- Neutral: dev stays on `.env` for speed; prod parity is opt-in.

## Enforcement

- **semgrep (keel ruleset):** bans `os.environ` / `os.getenv` and direct secret-store SDK calls outside the config/secret adapters — secrets are reachable only through the `SecretProvider` port.
- **gitleaks** (pre-commit + CI): no credentials are ever committed.
- Redaction of secret-like log keys is part of the logging contract (see [ADR-0010](0010-enforcement-strategy.md)).

## More information

- Realizes the `secrets` section of [`platform.yaml`](../../platform.yaml).
- Pairs with [ADR-0006](0006-identity-and-access.md) (mTLS certs) and [ADR-0004](0004-infrastructure-strategy.md) (deployment).
