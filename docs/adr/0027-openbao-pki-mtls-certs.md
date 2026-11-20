# 0027. OpenBao PKI issues + rotates mTLS certs via cert-manager

- **Status:** accepted <!-- proposed | accepted | rejected | deprecated | superseded by ADR-XXXX -->
- **Date:** 2026-11-20
- **Deciders:** keel maintainers

## Context and problem statement

ADR-0007 chose OpenBao as keel's internal CA, issuing short-lived certs for service-to-service
**mTLS** (ADR-0006). Each vertical already ships the mTLS *credential builders* that consume a cert +
key + CA (the `mtls_*_credentials` factories, gRPC mTLS). But the certs themselves are provisioned
**ad hoc** - there is no PKI engine stood up, no issuing role, and no rotation. A long-lived or
hand-provisioned cert defeats the point of an internal CA. This ADR closes the loop (v0.8, epic
#421): stand up the OpenBao **PKI** engine and wire **automatic issuance + rotation** of short-lived
mTLS certs per deployment, delivered to pods as the mTLS builders already expect.

## Decision drivers

- **Short-lived + auto-rotated** - certs expire quickly and renew before expiry with no human in the
  loop; no long-lived cert material anywhere.
- **Declarative + Kubernetes-native** - fits keel's Helm-deployed, hardened (PSS/NetworkPolicy)
  posture; a cert should be a declared resource, not an imperative step.
- **No ad-hoc certs / fail-closed** - a service gets its cert from the CA or it does not come up;
  the mTLS trust chain is the OpenBao PKI, not a self-signed afterthought.
- **CI-demonstrable** - proven, not asserted: a kind-cluster CI job must show a cert issued from the
  OpenBao PKI with the expected CA + identity, and the mTLS path working.

## Considered options

| Criterion | **cert-manager + Vault issuer** (chosen) | OpenBao Agent sidecar/injector | Direct issue (init + CronJob) |
|---|---|---|---|
| Delivery | declarative `Certificate` CR -> TLS `Secret`, mounted by the pod | per-pod agent templates the cert to a shared volume | init container writes the cert at startup |
| Rotation | automatic, `renewBefore` expiry, in cluster | automatic, agent renews in place | restart/CronJob-driven (weakest) |
| K8s-native fit | first-class CRDs; one `ClusterIssuer` + per-service `Certificate` in the Helm chart | sidecar + annotations in every pod | init container + a CronJob per service |
| Operational surface | one controller (cert-manager), cluster-wide | a sidecar in every service pod | no controller, but imperative + custom rotation |
| OpenBao fit | cert-manager's **Vault** issuer speaks the Vault API, which OpenBao implements | native (OpenBao Agent) | native (PKI HTTP API) |

## Decision

Use **cert-manager with its Vault issuer pointed at the OpenBao PKI.** cert-manager is the k8s-native,
declarative way to turn a CA into managed, auto-rotated TLS secrets: one `ClusterIssuer` wraps the
OpenBao PKI role, and each service declares a `Certificate` whose renewal cert-manager handles
in-cluster. It fits keel's Helm + hardening model (a cert is a declared resource in the service
chart) and avoids a sidecar in every pod. cert-manager's **Vault** issuer talks the Vault HTTP API,
which OpenBao implements, so it drives the OpenBao PKI directly. (The OpenBao Agent sidecar is the
reasonable Vault-native alternative if keel ever wants to avoid cert-manager; it trades the
controller for a sidecar in every pod.)

### The PKI + issuance path

1. **OpenBao PKI engine** (bootstrapped by a setup script; dev via the compose OpenBao, prod via the
   same steps in the cluster's OpenBao): a mount at `pki/` with a CA (root, or root + an intermediate
   `pki_int/` for a shorter-lived issuing CA), and a **role** `keel-service` that may issue certs for
   the keel service DNS names (`*.svc`, `*.svc.cluster.local`) with a **short TTL** (e.g. 24h-72h),
   `server_auth` + `client_auth` key usage (mTLS is bidirectional), and no long `max_ttl`.
2. **cert-manager `ClusterIssuer`** (Vault type): `server: <openbao-addr>`, `path: pki/sign/keel-service`
   (or `pki_int/sign/...`), authenticating to OpenBao via the **Kubernetes auth method** - cert-manager's
   ServiceAccount token is exchanged for an OpenBao token bound to a policy that can only use that one
   sign path. No static OpenBao token in the cluster.
3. **Per-service `Certificate`** (in the `keel-service-base` library chart / each service chart,
   opt-in): `issuerRef` -> the ClusterIssuer, `secretName` -> the TLS secret the pod mounts,
   `dnsNames` -> the service's in-cluster names, `duration` short + `renewBefore` set so cert-manager
   rotates ahead of expiry. The pod mounts the secret; the existing `mtls_*_credentials` builders load
   `tls.crt`/`tls.key`/`ca.crt` from it - no app code change.

The api_key credential type is unaffected: api keys are hashed keys sourced + rotated through the
`SecretProvider` (OpenBao KV, with the caching core's background refresh, v0.7). This ADR is the
mTLS-cert half of ADR-0007's PKI story.

### Proof (kind-cluster CI)

A CI job stands up a **kind** cluster with OpenBao (dev mode, PKI enabled + the `keel-service` role)
and cert-manager, applies the Vault `ClusterIssuer` and a test `Certificate`, and asserts:

- a cert is **issued** - the `Certificate` becomes Ready and its `Secret` contains a `tls.crt`
  **chaining to the OpenBao PKI CA** with the expected DNS SANs and a short lifetime;
- the **mTLS path works** - a client presenting the issued cert completes a mutual-TLS handshake
  against a server using an issued cert (or, minimally, the issued cert verifies against the PKI CA);
- **rotation** - with a short duration + `renewBefore`, cert-manager reissues before expiry (shown by
  the secret's cert serial changing), so rotation is automatic, not restart-driven.

The job fails loudly if the cert is not issued from the PKI or does not chain to the OpenBao CA.

## Consequences

- **Good:** short-lived, auto-rotated mTLS certs issued from the OpenBao CA, declared per service and
  renewed in-cluster - no long-lived or hand-provisioned cert material; fits the existing mTLS
  builders with no app change; CI-proven end to end.
- **Bad:** a second cluster controller (cert-manager) alongside Kyverno (ADR-0026), and the OpenBao
  PKI must be bootstrapped (CA created, role + k8s-auth policy configured) before issuance works -
  a one-time setup captured in a script and the CI job.
- **Neutral:** cert-manager's Vault issuer is used against OpenBao (Vault-API-compatible); if keel
  later standardises on OpenBao Agent or SPIFFE/SPIRE for workload identity, the `Certificate`
  resources are the swap point and the mTLS builders stay as-is.

> **Implementation status:** implemented in v0.8. The PKI bootstrap (`deploy/pki/bootstrap.sh`),
> the Vault `ClusterIssuer` + its k8s-auth RBAC (`deploy/pki/cluster-issuer.yaml`), the opt-in,
> default-off `mtls.*` Certificate wiring in the `keel-service-base` chart, and the kind-cluster CI
> job (`.github/workflows/pki.yml`) are in place. The CI job proves issuance (cert chains to the
> OpenBao CA, expected SANs + server/client EKUs + short TTL), the mTLS path (a real mutual-TLS
> handshake), and rotation (cert-manager auto-renews; the Secret's cert serial changes). ADR-0007's
> status and the `docs/STATUS.md` `api_key`/`mTLS` row are flipped accordingly.
