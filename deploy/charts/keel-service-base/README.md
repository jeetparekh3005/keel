# keel-service-base

A Helm **library chart** (ADR-0009 Tier 3, ADR-0021) holding the shared, hardened Kubernetes
templates for every keel reference service: the Deployment (non-root, read-only rootfs, dropped
caps, seccomp RuntimeDefault, startup/liveness/readiness probes, topology spread), Service,
NetworkPolicy (default-deny), PodDisruptionBudget, and ServiceAccount (no mounted token), plus the
shared label/name helpers.

It renders nothing on its own. Each per-service chart declares it as a dependency and includes its
named templates:

```yaml
# <service>/Chart.yaml
dependencies:
  - name: keel-service-base
    version: "0.5.0"
    repository: "file://../keel-service-base"
```

```yaml
# <service>/templates/deployment.yaml
{{ include "keel-service-base.deployment" . }}
```

The service chart keeps only what is service-specific: its `values.yaml`, `values.schema.json`, and
`configmap.yaml` (the `KEEL_*` config). A hardening change lands once here and propagates to every
service by a dependency version bump, rather than being copied into each chart.

## Exported templates

`keel-service-base.deployment` · `.service` · `.networkpolicy` · `.poddisruptionbudget` ·
`.serviceaccount`, plus the `.name` / `.fullname` / `.labels` / `.selectorLabels` helpers. They run
in the consuming chart's context, so `.Chart`, `.Release`, and `.Values` resolve to that service.
