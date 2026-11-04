# reference-service Helm chart

Hardened Kubernetes deployment for the keel reference service (ADR-0004, ADR-0008).

## Install

```sh
# Provide the DB URL as a Secret (never in values):
kubectl create secret generic ref-db --from-literal=KEEL_DATABASE_URL="postgresql+asyncpg://..."

helm install ref deploy/charts/reference-service \
  --set database.existingSecret=ref-db \
  --set config.oidcIssuer=https://keycloak/realms/keel \
  --set config.oidcJwksUri=https://keycloak/realms/keel/protocol/openid-connect/certs
```

## Hardening baked in

- Non-root (UID 65532), read-only root filesystem (writable `/tmp` only),
  `allowPrivilegeEscalation: false`, all capabilities dropped, seccomp
  `RuntimeDefault`, no mounted ServiceAccount token.
- Default-deny `NetworkPolicy` (ingress only to the HTTP port; egress only to
  DNS plus the configured dependency ports). Tighten `networkPolicy.egressPorts`
  and add `to` selectors per environment.
- Liveness (`/healthz`) and readiness (`/readyz`) probes; CPU/memory requests
  and limits.

The image is the signed, attested artifact published to GHCR by the release
pipeline. `helm lint` and `kubeconform` validate the chart in CI.
