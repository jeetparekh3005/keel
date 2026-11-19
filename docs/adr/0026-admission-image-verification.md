# 0026. Admission-time image-signature verification (sigstore policy-controller)

- **Status:** accepted <!-- proposed | accepted | rejected | deprecated | superseded by ADR-XXXX -->
- **Date:** 2026-11-20
- **Deciders:** keel maintainers

## Context and problem statement

keel builds every release image, signs it keyless with **cosign**, and attaches a **SLSA build
provenance** + an **SPDX SBOM** attestation (ADR-0008, ADR-0010, verified in the v0.7.0 release).
But nothing on the deploy side checks any of that: a cluster will happily run an unsigned image, a
tampered image, or an image from an untrusted source. The supply-chain loop is open at exactly the
point it matters - admission. ADR-0010 section 5 flagged "cluster-side signature admission
verification" as the remaining gap. This ADR closes it: a Kubernetes admission control that verifies
the cosign signature **and** the SLSA provenance against the keel signing identity, and **blocks**
anything that fails, before a Pod is admitted.

## Decision drivers

- **Verify exactly what keel produces** - keyless cosign signatures from the keel GitHub Actions
  workflow identity (Fulcio/OIDC) plus a SLSA provenance attestation. The admission check must bind
  to that identity, not merely "is it signed by someone".
- **Fail closed** - an image that is unsigned, signed by the wrong identity, or missing its
  provenance is **denied** admission, not warned. Consistent with keel's fail-closed posture
  everywhere else (auth, secret selection, broker selection).
- **Minimal operational surface** - one cluster component, scoped to the images and namespaces keel
  owns; it must not become a general policy framework the project then has to run and reason about.
- **CI-demonstrable** - the guarantee is proven, not asserted: a kind-cluster CI job must show a
  keel-signed image admitted and an unsigned/untrusted image rejected (no over-claim, per the repo's
  STATUS discipline).

## Considered options

| Criterion | **sigstore policy-controller** (chosen) | Kyverno | Ratify + Gatekeeper |
|---|---|---|---|
| Purpose fit | Purpose-built for sigstore: `ClusterImagePolicy` maps 1:1 to "keyless identity + attestation" | General policy engine; `verifyImages` rule does cosign + attestation as one feature among many | Verifier plugin (Ratify) feeding an OPA/Gatekeeper constraint; most moving parts |
| cosign keyless + SLSA attestation | first-class (`authorities.keyless` + `attestations.predicateType`) | supported (`attestors.keyless` + `attestations.type`) | supported via Ratify verifiers |
| Operational surface | one webhook, sigstore-scoped | one engine, broad scope (could grow to carry PSS/NetworkPolicy later) | two components (verifier + policy engine) |
| Maintained by | the sigstore project (tracks cosign/Fulcio/Rekor directly) | Nirmata/CNCF | Microsoft/CNCF |
| Fit to keel today | tightest - keel only needs "verify our sigstore images" | heavier than needed for a single image-verification policy | over-engineered for this |

## Decision

Use **sigstore policy-controller**. It is purpose-built for verifying sigstore artifacts, and its
`ClusterImagePolicy` expresses keel's exact requirement directly: a keyless identity (the keel GHA
workflow via the GitHub OIDC issuer) **and** a SLSA provenance attestation, scoped to keel's images.
It tracks cosign/Fulcio/Rekor as the same project, so it stays aligned with how keel signs. Kyverno
is the reasonable alternative if keel later wants one engine for broader policy (PSS/NetworkPolicy
consolidation); that is not a v0.8 need and would trade a tighter fit for a larger surface now.

### The policy

A cluster-scoped `ClusterImagePolicy` (committed under `deploy/admission/`):

- **Scope:** `images: [{ glob: "ghcr.io/jeetparekh3005/keel/**" }]` - keel's published images only.
  Images outside the glob are not governed by this policy (other registries are out of scope here).
- **Authority (keyless):** `issuer: https://token.actions.githubusercontent.com`, and
  `subjectRegExp: ^https://github.com/jeetparekh3005/keel/\.github/workflows/.+@.+$` - the same
  keel-workflow identity the v0.7.0 images were verified against in the release checks.
- **Attestation:** require a `https://slsa.dev/provenance/v1` predicate (the SLSA build provenance),
  so a cosign signature alone is not enough - the image must also carry keel's provenance.
- **Mode:** `enforce` (deny on failure), not `warn`.
- **Namespace opt-in:** policy-controller only acts on namespaces labelled
  `policy.sigstore.dev/include: "true"`. keel's service namespaces carry that label (wired into the
  Helm chart / deploy docs); a namespace without it is NOT protected - this is the one operational
  footgun and is called out in the deploy docs and the STATUS note.

### Proof (kind-cluster CI)

A CI job (`.github/workflows/admission.yml`) stands up a **kind** cluster, installs the pinned
policy-controller, applies the `ClusterImagePolicy`, labels a test namespace, and asserts both
directions:

- a **keel-signed** release image (a `ghcr.io/jeetparekh3005/keel/*` tag) is **admitted**;
- an **unsigned / untrusted** image (a stock public image, and/or a locally-built unsigned one) is
  **rejected** by the admission webhook.

The cluster is given registry pull access (the CI `GITHUB_TOKEN`) so policy-controller can fetch the
signatures/attestations from ghcr; the job fails if the "signed admits" or the "unsigned rejects"
assertion does not hold.

## Consequences

- **Good:** the supply-chain loop is closed and fail-closed - a cluster running this policy cannot
  admit an image that is not keel-signed and SLSA-attested by the keel workflow; the guarantee is
  CI-proven, not asserted.
- **Bad:** a new cluster component to install and keep current (pinned, updated deliberately); and
  the namespace opt-in label means an unlabelled namespace is silently unprotected - mitigated by
  wiring the label into the service chart and documenting it.
- **Neutral:** policy-controller is sigstore-scoped; broader admission policy (e.g. consolidating
  PodSecurity/NetworkPolicy) would need Kyverno or Gatekeeper later - deferred until there is a need.

> **Implementation status:** proposed in this ADR; flip ADR-0010 section 5 and the `docs/STATUS.md`
> admission row to Implemented only once the kind-cluster CI job proves both the admit and the reject
> paths, per the repo's no-over-claim rule.
