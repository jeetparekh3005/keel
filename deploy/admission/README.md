# keel admission-time image verification (ADR-0026)

A Kubernetes admission control that verifies keel's cosign keyless signature **and** its SLSA build
provenance before a Pod is admitted, and **denies** anything that fails. It closes the supply-chain
loop at the point it matters: admission. See [ADR-0026](../../docs/adr/0026-admission-image-verification.md).

The verifier is **[Kyverno]**, using an **`ImageValidatingPolicy`** (the CEL-based policy type under
`policies.kyverno.io`).

[Kyverno]: https://kyverno.io

## Why Kyverno, and why the new `ImageValidatingPolicy`

keel signs with **cosign v3** (`cosign sign`) plus **`actions/attest-build-provenance`**. Both publish
the signature and the SLSA provenance as **OCI 1.1 referrers in the modern sigstore bundle format**
(`application/vnd.dev.sigstore.bundle.v0.3+json`), not the legacy `.sig`/`.att` tags.

- **sigstore policy-controller cannot read that format** - every released version (through v0.15.1,
  even with `enable-oci11`) reports `no signatures found` / `no matching attestations` against keel's
  real images. ADR-0026 originally selected policy-controller; that was revised to Kyverno after this
  was proven in a kind cluster.
- **Kyverno's legacy `kyverno.io/v1` ClusterPolicy `verifyImages`** also cannot read it (same
  `no signatures found`), and Kyverno **v1.20 removed execution** of legacy `kyverno.io` policy types.
- **Kyverno's `ImageValidatingPolicy`** (Kyverno >= v1.20, CEL + the sigstore-go verification stack)
  **does** verify keel's modern bundle/referrer signature and SLSA attestation. This is proven against
  the real `ghcr.io/jeetparekh3005/keel/reference-service:0.7.0` image by the CI job
  (`.github/workflows/admission.yml`).

## What is here

- `image-validating-policy.yaml` - the `ImageValidatingPolicy`. Scoped to
  `ghcr.io/jeetparekh3005/keel/**`, binds the keel keyless workflow identity, requires the
  `https://slsa.dev/provenance/v1` attestation, `validationActions: [Deny]` (enforce),
  `failurePolicy: Fail` (fail closed). A plain cosign signature alone is not enough: both CEL
  validations (signature **and** SLSA provenance) must pass.

## Pinned version

| Component | Pin | Notes |
|---|---|---|
| Kyverno Helm chart | `kyverno/kyverno` **3.10.0** | from `https://kyverno.github.io/kyverno/` |
| Kyverno app version | **v1.20.0** | first line with the CEL `ImageValidatingPolicy` + sigstore-go verifier |

Bump deliberately. The CI proof (`.github/workflows/admission.yml`) re-runs the admit+reject
assertions on every change, so a version bump that breaks verification fails CI.

## Install

```sh
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update kyverno

helm install kyverno kyverno/kyverno \
  --version 3.10.0 \
  --namespace kyverno --create-namespace \
  --wait

# Apply keel's policy (cluster-scoped).
kubectl apply -f deploy/admission/image-validating-policy.yaml
```

The public repo (`jeetparekh3005/keel`) signs keyless against the **public-good** sigstore
(Fulcio/Rekor), which is Kyverno's default trust root, so no extra trust-root config is needed. The
keel ghcr packages are currently **public**, so Kyverno fetches the signature and attestation from
ghcr without credentials. If they are ever made private, give Kyverno registry credentials (an
`imagePullSecret` referenced from the policy's `attestors[].cosign.source.pullSecrets`, or Kyverno's
global image-pull-secrets config).

## Scope: cluster-wide by image reference (no namespace opt-in)

Unlike sigstore policy-controller, Kyverno matches Pods **by image reference cluster-wide** via
`matchImageReferences`. Any Pod in any namespace whose image matches
`ghcr.io/jeetparekh3005/keel/**` is verified - there is **no** `policy.sigstore.dev/include` namespace
label and therefore **no "unlabelled namespace is silently unprotected" footgun**. This is why the
keel service Helm charts carry **no** admission-related namespace wiring.

Images **outside** the glob (e.g. a stock `registry.k8s.io/pause`) are deliberately **not** governed
by this policy and are admitted. The policy's job is "every keel image that runs is keel-signed and
SLSA-attested", not "every image in the cluster is signed"; broadening to all images would require
per-image policies for the cluster's own system images and is out of scope for ADR-0026.

## Fail-closed behavior

- `validationActions: [Deny]` - a keel-glob image that is unsigned, signed by the wrong identity, or
  missing its SLSA provenance is **denied** admission.
- `failurePolicy: Fail` - if verification itself errors or times out, admission is **denied**, not
  waved through.
- First-verification latency: keyless verification fetches the sigstore trust root + Fulcio/Rekor
  material, so the first check after a cold start can be slow; `webhookConfiguration.timeoutSeconds`
  is set to 30 (Kyverno's max) and Kyverno caches results in-process + in its image-verify cache, so
  steady-state checks are fast. The CI proof retries the first admit to absorb cold-start latency.
