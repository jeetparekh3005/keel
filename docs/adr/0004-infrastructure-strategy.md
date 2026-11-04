# 0004. Infrastructure and deployment strategy

- **Status:** accepted (implementation targeted for v0.2; see roadmap)
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

Generated services need a consistent, secure path from container to running workload. We must choose a deployment target and a cloud posture that keep the golden path portable and auditable without coupling every service to one vendor.

## Decision drivers

- Portability - avoid lock-in; the same service should run across environments and clouds.
- Security and supply-chain integrity by default.
- Fast inner-loop for developers; production parity when needed.
- Fits keel's propagation model (versioned, updatable artifacts).

## Considered options

| Option | Portability | Ops complexity | Scales to zero | Best fit |
|---|---|---|---|---|
| **Kubernetes** | High (any cloud/on-prem) | High | With KEDA/add-ons | Orgs already on k8s; many services |
| Serverless containers | Medium (cloud-specific) | Low | Yes (native) | Few services, minimal ops |
| PaaS (Fly/Render/etc.) | Low-Medium | Lowest | Varies | Prototypes, small teams |

## Decision outcome

**Deploy target: Kubernetes. Cloud posture: cloud-agnostic.**

### Containers (settled defaults, shipped with each vertical)

- Multi-stage OCI builds on a **shell-less, non-root** base (**Chainguard** default); see [ADR-0008](0008-container-hardening.md) for hardening and code-protection.
- Base images pinned by **digest**, bumped by Renovate/Dependabot.
- Image healthcheck honors the contract's `/healthz` / `/readyz`.

### Kubernetes

- **Helm chart per service** (versioned, so it propagates like other platform artifacts), with environment **values overlays** (`dev`/`staging`/`prod`). Kustomize is an acceptable alternative for overlay-only needs.
- Resource requests/limits, liveness/readiness probes, `PodSecurityContext` (non-root, read-only rootfs), and a `NetworkPolicy` are part of the generated chart defaults.
- **GitOps** (Argo CD or Flux) is the recommended delivery mechanism: CI builds, signs, and pushes the image and bumps the chart; the cluster reconciles. Optional but default-on in the golden path.

### Cloud-agnostic

- No cloud-specific managed services in the golden path.
- **Postgres**: vanilla - any managed Postgres, or in-cluster via an operator (e.g. CloudNativePG). The contract's `Repository` adapter stays provider-neutral.
- **Secrets**: `SecretProvider` prod adapter defaults to **OpenBao** (MPL-2.0, OSS fork of Vault), synced into the cluster via the **External Secrets Operator** so any backend (incl. cloud secret managers) can be swapped in later without code change. See [ADR-0007](0007-secrets-and-pki.md).
- **Infrastructure as Code**: **OpenTofu** (MPL-2.0, OSS fork of Terraform). HashiCorp's BSL-licensed originals (Vault/Terraform) remain documented swaps.
- **Telemetry**: in-cluster **OpenTelemetry Collector** exporting OTLP to a swappable backend.
- Cloud-specific adapters (AWS/GCP/Azure secret managers, managed DBs) are added later *behind the existing ports* - they do not change the golden path.

### Supply chain

- SBOM (syft/CycloneDX), image signing (**cosign**), and provenance on every release.
- Optional cluster hardening: admission-time signature verification (policy-controller / Kyverno).

### Local development

- **docker-compose** remains the inner-loop (service + Postgres + Keycloak + OTel) for speed - *not* Kubernetes.
- Optional k8s parity via kind/minikube + Tilt/Skaffold for engineers who need it.

### Guardrails

- The **"simple service"** variant may target a simpler runtime; don't force full k8s complexity onto trivial workloads.
- Generated manifests stay minimal and readable - no 500-line charts.

### Consequences

- Good: portable across clouds; vendor swaps are adapter/values changes, not rewrites.
- Good: security posture (non-root, signed, SBOM, network policy) is default, not opt-in.
- Bad: forgoes some cloud-managed conveniences; more infra to template and maintain.
- Neutral: GitOps is a new concept for some teams; it is optional.

## Enforcement

Manifest and IaC hardening is enforced deterministically in CI:

- **kube-linter** + **conftest (OPA policies)** + **kubeconform** - rendered Kubernetes/Helm output must set `runAsNonRoot`, `readOnlyRootFilesystem`, drop all capabilities, declare resource requests/limits, carry a default-deny `NetworkPolicy`, and use digest-pinned images (no `:latest`).
- **trivy config** / **checkov** - OpenTofu misconfiguration scanning.
- **helm lint** - chart validity.

Image-level hardening is enforced in [ADR-0008](0008-container-hardening.md).

## More information

- Deploys the hexagonal services from [ADR-0002](0002-hexagonal-architecture.md) and honors [`platform.yaml`](../../platform.yaml) ports (secrets, telemetry, health).
- Component decisions: [ADR-0005](0005-api-gateway.md) gateway, [ADR-0006](0006-identity-and-access.md) identity, [ADR-0007](0007-secrets-and-pki.md) secrets & PKI.
- Implementation tracked under milestone **v0.2** (monorepo + frontend) and a dedicated infra issue to be opened.
