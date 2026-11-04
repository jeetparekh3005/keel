# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via [GitHub Security Advisories](https://github.com/jeetparekh3005/keel/security/advisories/new) or email the maintainer at **jeetparekh3005@gmail.com**. You will receive an acknowledgement within **3 business days**, and we will coordinate a fix and disclosure with you.

> **Maintainership note.** keel is currently maintained by a single person (bus
> factor 1). Response times reflect that; a second maintainer and a documented
> escalation path are tracked for a future milestone. Report anyway — advisories
> and the email above are monitored.

## Scope

keel generates project scaffolds with security controls baked in. Security-relevant areas include:

- Generated **auth** adapters and access-control defaults
- **Secret handling** (keel never commits secrets; generated projects use secret-provider ports)
- **Supply chain** — dependency pinning, SBOM generation, and image provenance in generated CI
- **SAST / dependency scanning** defaults (bandit, pip-audit, gitleaks, semgrep, trivy)

If you find a scaffold that produces insecure defaults, that is a security issue — please report it.

## Supported versions

During early development (`0.x`), only the latest release is supported.

## Release integrity

Releases are cut by [release-please](https://github.com/googleapis/release-please)
and tagged `vX.Y.Z`. **Signed tags and build provenance (SLSA attestation) are not
yet in place** — tags are created by the release automation, not GPG-signed by a
maintainer key. Cryptographic signing (cosign) and provenance attestation are
planned alongside the image publish pipeline (see ADR-0008 and the v0.2 roadmap).
Until then, verify releases by commit SHA against this repository.
