# 0008. Container image hardening and code protection

- **Status:** accepted (implementation targeted for v0.1 Python vertical)
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

Generated images must be hardened so that a compromised container yields almost nothing and no tooling to pivot with, and so application source is not readable from the image. A requirement was raised to make code extraction impossible.

**Reality check (threat model):** an OCI image is a tarball of layers; anyone who holds the image (`docker save`, `skopeo`) or a running container (`kubectl cp`, debug sidecar) can read whatever the app process reads. Extraction cannot be made *impossible* for a distributed artifact - Python `.pyc` even decompiles to near-original source. The achievable goal is therefore: minimize attack surface, remove readable source, and make **access to the image itself** the real control.

## Decision drivers

- Minimal runtime attack surface (no shell, no package manager).
- No plaintext source in the image.
- Honest guarantee: the image never reaches untrusted parties.

## Considered options

| Base image | Shell/pkg mgr | Non-root default | CVE surface | SBOM | Notes |
|---|---|---|---|---|---|
| **Chainguard (Wolfi)** | None | Yes | Typically zero | Included | Strongest posture |
| Distroless (Google) | None | Yes | Low | External | Battle-tested |
| UBI Micro (Red Hat) | Minimal | Configurable | Moderate | External | For RH/UBI-standardized orgs |

## Decision outcome

**Default base: Chainguard. Multi-stage build. Code protection offered in two variants. Runtime locked down via Kubernetes `securityContext`. Image integrity via signing + admission control. Distribution restricted to a private registry.**

### Base image & build

- `cgr.dev/chainguard/python` (shell-less, non-root, typically zero-CVE), pinned by **digest**, bumped by Renovate.
- Multi-stage: toolchain only in the builder; runtime copies the venv + app.
- Swappable to distroless or UBI Micro behind the same build contract.

### Code protection (two variants)

- **Default - bytecode-only:** `python -m compileall -b` then delete `.py`; ship only `.pyc`. No plaintext source; decompilable with effort.
- **Hardened - native compile:** a build flag compiles the service with **Nuitka** to a native binary; source recovery is genuinely hard. Costs: slower builds, library-compat testing, harder debugging. Opt-in per service.

### Runtime hardening (Helm chart `securityContext`)

`runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, no serviceaccount-token automount unless required, default-deny egress NetworkPolicy.

### Integrity & distribution (the real guarantee)

- **cosign**-sign every image; **admission policy** (Kyverno / sigstore policy-controller) runs only signed, verified images.
- **SBOM** (CycloneDX) + **trivy** CVE gate + SLSA provenance in CI.
- **Private registry with RBAC**; images are never publicly distributed.

### Consequences

- Good: a compromised container is a shell-less, read-only, non-root box exposing only bytecode (or a native binary).
- Good: for an internal platform deployed to self-managed clusters, access control + signing closes the realistic extraction path.
- Bad: Nuitka variant adds build/debug cost; native compile is not absolute protection.
- Honest: this does not make extraction impossible; it raises cost and restricts who can obtain the image.

> **Implementation status (v0.1):** the Dockerfile (multi-stage, Chainguard, non-root,
> bytecode-only) exists, but **digest pinning and the Kubernetes `securityContext`/
> NetworkPolicy manifests are not yet present** (no Helm/k8s in the repo) - see
> [docs/STATUS.md](../STATUS.md). Runtime hardening is specified, not yet enforced.

## Enforcement

- **hadolint:** Dockerfiles must be non-root, use a digest-pinned base, avoid `:latest`, and leave no package-manager cruft.
- **trivy:** image CVE scan with a severity gate; a **CycloneDX SBOM** must be produced.
- **cosign verify** in CI plus an admission policy (Kyverno / sigstore policy-controller) so only signed, verified images run.
- Runtime `securityContext` is enforced at the manifest level - see [ADR-0004](0004-infrastructure-strategy.md).

## More information

- Deployment and `securityContext` live with [ADR-0004](0004-infrastructure-strategy.md).
- Realizes the `image` section of [`platform.yaml`](../../platform.yaml).
