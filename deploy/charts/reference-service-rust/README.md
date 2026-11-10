# reference-service-rust Helm chart

Hardened Kubernetes deployment for the keel reference service, Rust vertical (ADR-0004, ADR-0008, ADR-0017).

## Install

```sh
# Provide the DB URL as a Secret (never in values). The Rust service uses sqlx, so the
# URL is a plain postgres:// DSN (no SQLAlchemy +asyncpg suffix):
kubectl create secret generic ref-db --from-literal=KEEL_DATABASE_URL="postgres://user:pass@postgres:5432/keel"

helm install ref deploy/charts/reference-service-rust \
  --set database.existingSecret=ref-db \
  --set config.oidcIssuer=https://keycloak/realms/keel \
  --set config.oidcJwksUri=https://keycloak/realms/keel/protocol/openid-connect/certs
```

## Hardening baked in

- Non-root (UID 65532), read-only root filesystem (writable `/tmp` only),
  `allowPrivilegeEscalation: false`, all capabilities dropped, seccomp
  `RuntimeDefault`, no mounted ServiceAccount token.
- Default-deny `NetworkPolicy`: ingress to the HTTP port only from the configured
  sources (`networkPolicy.ingressFrom`, default scoped to the ingress-controller
  namespace), egress to DNS plus the in-cluster dependency ports; set
  `networkPolicy.egressIPBlocks` to reach an external IdP over TLS. Scope
  `ingressFrom`/`egressNamespaceSelector` to your cluster.
- `PodDisruptionBudget` (minAvailable 1) and node topology spread so a drain
  cannot take the service to zero.
- Startup, liveness (`/healthz`), and readiness (`/readyz`) probes; CPU/memory
  requests and limits.
- `values.schema.json` validates values; CI asserts the securityContext posture
  (`ci/policy_check.py`) so it cannot silently regress.

The image is the signed, attested artifact published to GHCR by the release
pipeline. `helm lint` and `kubeconform` validate the chart in CI.
