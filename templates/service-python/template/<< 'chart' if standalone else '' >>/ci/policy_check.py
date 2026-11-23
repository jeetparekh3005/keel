"""Assert the chart's Pod Security Standards posture on the rendered manifests.

kubeconform validates schema shape only, so a regression that drops
`readOnlyRootFilesystem` or `runAsNonRoot` would pass it. This check reads
`helm template` output on stdin and fails if the Deployment's hardening is not
present, so the security posture the chart advertises is actually enforced in CI.
"""

from __future__ import annotations

import sys

import yaml


def _fail(msg: str) -> None:
    print(f"POLICY FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    docs = [d for d in yaml.safe_load_all(sys.stdin.read()) if d]
    deployments = [d for d in docs if d.get("kind") == "Deployment"]
    if not deployments:
        _fail("no Deployment found in the rendered manifests")

    for dep in deployments:
        spec = dep["spec"]["template"]["spec"]
        if spec.get("automountServiceAccountToken") is not False:
            _fail("automountServiceAccountToken must be false")

        pod_sc = spec.get("securityContext", {})
        if pod_sc.get("runAsNonRoot") is not True:
            _fail("pod securityContext.runAsNonRoot must be true")
        if pod_sc.get("seccompProfile", {}).get("type") != "RuntimeDefault":
            _fail("pod seccompProfile.type must be RuntimeDefault")

        containers = spec.get("containers", [])
        if not containers:
            _fail("Deployment has no containers")
        for container in containers:
            csc = container.get("securityContext", {})
            if csc.get("allowPrivilegeEscalation") is not False:
                _fail(f"{container['name']}: allowPrivilegeEscalation must be false")
            if csc.get("readOnlyRootFilesystem") is not True:
                _fail(f"{container['name']}: readOnlyRootFilesystem must be true")
            if "ALL" not in csc.get("capabilities", {}).get("drop", []):
                _fail(f"{container['name']}: capabilities.drop must include ALL")
            limits = container.get("resources", {}).get("limits", {})
            if "cpu" not in limits or "memory" not in limits:
                _fail(f"{container['name']}: resources.limits must set cpu and memory")

    print(f"POLICY OK: {len(deployments)} Deployment(s) meet the PSS-restricted posture")


if __name__ == "__main__":
    main()
