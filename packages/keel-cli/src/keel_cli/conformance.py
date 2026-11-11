"""Static ``platform.yaml`` conformance checks for a generated keel service.

These verify that a *thin* service is wired to the platform (depends on ``keel-core``, builds its
app with keel-core's factory, extends keel-core's typed config, guards its routes) rather than
re-checking behaviour that keel-core already owns and tests. The health endpoints, RFC 9457 error
shape, redacting logs, and edge hardening are mounted by keel-core's ``create_app`` and verified by
keel-core's own suite; a thin service's job is to *use* them, which is exactly what this gate
confirms.

This is a fast, dependency-free check to run right after ``keel new`` / ``keel update`` and in CI.
It is deliberately not a replacement for the service's behavioural conformance suite
(``tests/test_conformance.py``) or the runtime deny-by-default startup check.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

# apiVersions whose contract shape this CLI knows how to check. Extend when the schema changes.
KNOWN_API_VERSIONS = frozenset({"keel.dev/v1alpha1"})


@dataclass(frozen=True)
class CheckResult:
    """The outcome of one static conformance check.

    An ``advisory`` check is reported but does not fail conformance: a hand-written or
    source service (such as the reference service, which is the template's origin) can be
    fully platform-conformant yet not be a Copier-tracked instance.
    """

    check_id: str
    ok: bool
    detail: str
    advisory: bool = False


@dataclass(frozen=True)
class ConformanceReport:
    """The results of checking one service directory against the contract."""

    service_dir: Path
    results: tuple[CheckResult, ...]

    @property
    def ok(self) -> bool:
        """True when every non-advisory check passed."""
        return all(result.ok for result in self.results if not result.advisory)


@dataclass(frozen=True)
class LanguageSpec:
    """Per-language markers for the wiring checks (static text/manifest signals)."""

    name: str
    manifest: str  # build manifest filename (its presence also detects the language)
    dep_module: str  # the keel-core library module name expected in the manifest
    source_suffix: str  # source file extension to scan
    app_factory: tuple[str, ...]  # any present => the keel-core app factory is used
    app_factory_detail: str
    typed_config: tuple[str, ...]
    typed_config_detail: str
    authz: tuple[str, ...]
    authz_detail: str


# Detection is by build manifest; order matters only in that each maps to exactly one language.
LANGUAGES: tuple[LanguageSpec, ...] = (
    LanguageSpec(
        name="python",
        manifest="pyproject.toml",
        dep_module="keel-core",
        source_suffix=".py",
        app_factory=("from keel_core.adapters.inbound.http import create_app",),
        app_factory_detail="keel_core create_app (health + RFC 9457 + edge hardening)",
        typed_config=("BaseServiceConfig",),
        typed_config_detail="config extends BaseServiceConfig (KEEL_ env prefix, fail-fast)",
        authz=("require_scopes", "require_roles"),
        authz_detail="routes guarded by require_scopes/require_roles",
    ),
    LanguageSpec(
        name="go",
        manifest="go.mod",
        dep_module="keel-core-go",
        source_suffix=".go",
        app_factory=("keel-core-go/httpx", "httpx.NewRouter("),
        app_factory_detail="keel-core-go httpx.NewRouter (health + RFC 9457 + edge hardening)",
        typed_config=("keel-core-go/config", "config.Load"),
        typed_config_detail="typed config via keel-core-go/config (KEEL_ env prefix, fail-fast)",
        authz=("RequireScopes", "auth.Middleware"),
        authz_detail="routes guarded by auth.RequireScopes/auth.Middleware",
    ),
    LanguageSpec(
        name="rust",
        manifest="Cargo.toml",
        dep_module="keel-core-rust",
        source_suffix=".rs",
        app_factory=("create_app_with_readiness",),
        app_factory_detail="keel_core create_app_with_readiness (health + RFC 9457 + hardening)",
        typed_config=("keel_core::config::load",),
        typed_config_detail="typed config via keel_core config::load (KEEL_ env prefix, fail-fast)",
        authz=("require_scopes", "webauth::Authed"),
        authz_detail="routes guarded by Authed::require_scopes",
    ),
)


def _detect(service_dir: Path) -> LanguageSpec | None:
    return next((spec for spec in LANGUAGES if (service_dir / spec.manifest).is_file()), None)


def _read_source(service_dir: Path, suffix: str) -> str:
    """Concatenate the service's source for coarse text checks (``src/`` first if present)."""
    src = service_dir / "src"
    base = src if src.is_dir() else service_dir
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(base.rglob(f"*{suffix}")))


def _check_contract(contract_path: Path) -> CheckResult:
    try:
        contract = yaml.safe_load(contract_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        return CheckResult("contract", ok=False, detail=f"cannot read {contract_path}: {exc}")
    api_version = contract.get("apiVersion") if isinstance(contract, dict) else None
    ok = api_version in KNOWN_API_VERSIONS
    detail = f"{contract_path} apiVersion={api_version!r}"
    if not ok:
        detail += f"; expected one of {sorted(KNOWN_API_VERSIONS)}"
    return CheckResult("contract", ok=ok, detail=detail)


def _marker_check(check_id: str, source: str, markers: tuple[str, ...], detail: str) -> CheckResult:
    present = any(marker in source for marker in markers)
    return CheckResult(check_id, ok=present, detail=detail if present else f"missing: {detail}")


def check_service(service_dir: Path, contract_path: Path) -> ConformanceReport:
    """Run every static conformance check against ``service_dir`` and return the report."""
    service_dir = service_dir.resolve()
    tracked = (service_dir / ".copier-answers.yml").is_file()

    results: list[CheckResult] = [
        # The contract resolves and is a version this CLI understands.
        _check_contract(contract_path),
        # Generated by (and therefore updatable from) a keel template. Advisory: a conformant
        # service need not be Copier-tracked, it just cannot `keel update`.
        CheckResult(
            "template-tracked",
            ok=tracked,
            detail=(
                ".copier-answers.yml present (keel update-able)"
                if tracked
                else "no .copier-answers.yml; not Copier-tracked, `keel update` unavailable"
            ),
            advisory=True,
        ),
    ]

    spec = _detect(service_dir)
    if spec is None:
        manifests = ", ".join(language.manifest for language in LANGUAGES)
        results.append(
            CheckResult("language", ok=False, detail=f"no known build manifest ({manifests})")
        )
        return ConformanceReport(service_dir=service_dir, results=tuple(results))

    manifest_text = (service_dir / spec.manifest).read_text(encoding="utf-8")
    source = _read_source(service_dir, spec.source_suffix)
    results += [
        # Depends on keel-core: the Tier-1 library every platform guarantee rides on.
        CheckResult(
            "keel-core-dependency",
            ok=spec.dep_module in manifest_text,
            detail=(
                f"{spec.dep_module} present in {spec.manifest}"
                if spec.dep_module in manifest_text
                else f"{spec.dep_module} not found in {spec.manifest}"
            ),
        ),
        # Builds its app with keel-core's factory (health + RFC 9457 + edge hardening).
        _marker_check("app-factory", source, spec.app_factory, spec.app_factory_detail),
        # Typed config from keel-core (KEEL_ env prefix, fail-fast, reject-unknown).
        _marker_check("typed-config", source, spec.typed_config, spec.typed_config_detail),
        # Deny-by-default authz on the routes.
        _marker_check("deny-by-default-authz", source, spec.authz, spec.authz_detail),
    ]
    return ConformanceReport(service_dir=service_dir, results=tuple(results))
