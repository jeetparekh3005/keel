# 0026. Admission-time image-signature verification (Kyverno ImageValidatingPolicy)

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

The decisive criterion turned out to be one that is easy to miss on paper: **can the verifier read
the format keel actually emits.** keel signs with cosign v3 + `actions/attest-build-provenance`,
which publish the signature and the SLSA provenance as **OCI 1.1 referrers in the modern sigstore
bundle format** (`application/vnd.dev.sigstore.bundle.v0.3+json`) - not the legacy tag-based
`<digest>.sig` / `.att` artifacts. This was validated empirically in a kind cluster against the real
`ghcr.io/jeetparekh3005/keel/reference-service:0.7.0` release image.

| Criterion | **Kyverno `ImageValidatingPolicy`** (chosen) | sigstore policy-controller | Kyverno legacy `verifyImages` |
|---|---|---|---|
| Reads keel's modern bundle / OCI 1.1 referrers | **yes** (CEL policy, sigstore-go verifier, Kyverno >= v1.20) - proven against the real v0.7.0 image | **no** - every released version incl. v0.15.1 `enable-oci11` fails with "no matching attestations / no signatures found" | **no** - its cosign verifier reports "no signatures found" (same as policy-controller); also **removed from execution** in Kyverno v1.20 |
| cosign keyless + SLSA attestation | `cosign.keyless.identities` + `attestations.intoto.type`, both asserted in CEL | first-class on paper (`authorities.keyless` + `attestations`) but unreadable for keel's format | on paper only |
| Scope model | cluster-wide by image reference (`matchImageReferences` glob) - no per-namespace opt-in | namespace opt-in via `policy.sigstore.dev/include` label (a footgun if forgotten) | by resource match rules |
| Operational surface | one engine; could later carry broader policy (PSS/NetworkPolicy) | one webhook, sigstore-scoped | n/a (deprecated) |

Ratify + Gatekeeper (a verifier plugin feeding an OPA constraint) was also on the table but is the
most moving parts for a single image-verification policy and was not evaluated once Kyverno's
`ImageValidatingPolicy` proved sufficient.

## Decision

Use **Kyverno's `ImageValidatingPolicy`** (the CEL/sigstore-go verifier, Kyverno >= v1.20).

This ADR originally chose sigstore policy-controller for its tight sigstore fit. Implementation
disproved that: policy-controller (and Kyverno's older `kyverno.io/v1` `verifyImages` rule) cannot
discover or verify keel's modern sigstore-bundle / OCI 1.1 referrer artifacts - the admit path fails
even though `cosign verify`, `cosign verify-attestation`, and `gh attestation verify` all succeed on
the same images. Keeping keel's signing modern and correct (it is the direction of the ecosystem and
what `gh attestation verify` consumes), the verifier is the piece that must read that format. Kyverno
v1.20's new CEL `ImageValidatingPolicy` does, verified end-to-end against the real release image. The
signing side (ADR-0008/0010) is unchanged.

### The policy

A cluster-scoped `ImageValidatingPolicy` (`policies.kyverno.io/v1`, committed under
`deploy/admission/image-validating-policy.yaml`):

- **Scope:** `matchImageReferences: [{ glob: "ghcr.io/jeetparekh3005/keel/**" }]` - keel's published
  images only. The policy matches **cluster-wide by image reference**, so there is **no namespace
  opt-in label** and therefore no "unlabelled namespace is silently unprotected" footgun (the chief
  drawback of the policy-controller model).
- **Authority (keyless):** `cosign.keyless.identities` with
  `issuer: https://token.actions.githubusercontent.com` and
  `subjectRegExp: ^https://github.com/jeetparekh3005/keel/\.github/workflows/.+@.+$` - the same
  keel-workflow identity the v0.7.0 images were cosign-verified against at release.
- **Attestation:** require the `https://slsa.dev/provenance/v1` in-toto predicate (SLSA build
  provenance), and a CEL `validations` block that asserts **both** the signature and the provenance
  hold - a signature alone is insufficient.
- **Mode:** `validationActions: [Deny]` with `failurePolicy: Fail` - block non-compliant Pods and
  fail closed on verification errors or timeouts.
- **Cold-start caveat:** the first keyless verification after a cold start fetches the sigstore trust
  root + Fulcio/Rekor material, which can approach the 30s webhook timeout and (fail-closed) deny;
  Kyverno caches the roots in-process, so subsequent verifications are fast. `timeoutSeconds: 30`
  (Kyverno's max) gives headroom; the CI demo tolerates a single cold-start retry. In production this
  is a non-issue after the first verification.

### Proof (kind-cluster CI)

A CI job (`.github/workflows/admission.yml`) stands up a **kind** cluster, installs the pinned
Kyverno (chart 3.10.0 / app v1.20.0), applies the `ImageValidatingPolicy`, and asserts both
directions against real artifacts:

- a **keel-signed** release image (`ghcr.io/jeetparekh3005/keel/reference-service:0.7.0`) is
  **admitted** - Kyverno verifies both the cosign keyless signature and the SLSA provenance;
- an **unsigned** image under the keel glob is **rejected** by the Kyverno webhook.

keel's ghcr packages are public, so the public-good sigstore trust root applies and no registry
credentials are required to fetch the signatures; the job dumps Kyverno logs and fails loudly if
either assertion does not hold.

## Consequences

- **Good:** the supply-chain loop is closed and fail-closed - a cluster running this policy cannot
  admit an image that is not keel-signed and SLSA-attested by the keel workflow; the guarantee is
  CI-proven against the real release image, and the cluster-wide image match avoids the namespace
  opt-in footgun. keel's modern signing is untouched.
- **Bad:** a new cluster component (Kyverno) to install and keep current; and the cold-start trust-
  root fetch can deny the very first verification after a restart until the roots are cached.
- **Neutral:** Kyverno is a general policy engine - more than a single image-verification policy
  needs, but it is the verifier that actually reads keel's format today, and it leaves room to
  consolidate broader policy (PodSecurity/NetworkPolicy) later if wanted.

> **Implementation status:** implemented. The kind-cluster CI job proves both the admit (real
> v0.7.0 image) and reject paths; ADR-0010 section 5 and the `docs/STATUS.md` admission row are
> flipped to Implemented in the same change.
