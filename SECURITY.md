# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via [GitHub Security Advisories](https://github.com/jeetparekh3005/keel/security/advisories/new) or email the maintainer. You will receive an acknowledgement within a reasonable timeframe, and we will coordinate a fix and disclosure with you.

## Scope

keel generates project scaffolds with security controls baked in. Security-relevant areas include:

- Generated **auth** adapters and access-control defaults
- **Secret handling** (keel never commits secrets; generated projects use secret-provider ports)
- **Supply chain** — dependency pinning, SBOM generation, and image provenance in generated CI
- **SAST / dependency scanning** defaults (bandit, pip-audit, gitleaks, semgrep, trivy)

If you find a scaffold that produces insecure defaults, that is a security issue — please report it.

## Supported versions

During early development (`0.x`), only the latest release is supported.
