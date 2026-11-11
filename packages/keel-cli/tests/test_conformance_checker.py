"""Conformance-checker tests: it must pass the real reference service and flag unwired ones."""

from __future__ import annotations

from pathlib import Path

from keel_cli.conformance import check_service

REPO = Path(__file__).resolve().parents[3]
REFERENCE = REPO / "services" / "reference-service"
CONTRACT = REPO / "platform.yaml"


GO_REFERENCE = REPO / "services" / "reference-service-go"
RUST_REFERENCE = REPO / "services" / "reference-service-rust"


def test_go_reference_service_passes_every_hard_check() -> None:
    report = check_service(GO_REFERENCE, CONTRACT)
    hard_failures = [r for r in report.results if not r.ok and not r.advisory]
    assert not hard_failures, f"Go reference should be conformant, failed: {hard_failures}"
    assert report.ok
    # Go wiring is detected via Go-specific markers, not the Python ones.
    assert _result(report, "keel-core-dependency").ok
    assert _result(report, "app-factory").ok
    assert _result(report, "deny-by-default-authz").ok


def test_rust_reference_service_passes_every_hard_check() -> None:
    report = check_service(RUST_REFERENCE, CONTRACT)
    hard_failures = [r for r in report.results if not r.ok and not r.advisory]
    assert not hard_failures, f"Rust reference should be conformant, failed: {hard_failures}"
    assert report.ok
    assert _result(report, "keel-core-dependency").ok
    assert _result(report, "app-factory").ok
    assert _result(report, "deny-by-default-authz").ok


def test_java_reference_service_passes_every_hard_check() -> None:
    report = check_service(REPO / "services" / "reference-service-java", CONTRACT)
    hard_failures = [r for r in report.results if not r.ok and not r.advisory]
    assert not hard_failures, f"Java reference should be conformant, failed: {hard_failures}"
    assert report.ok
    assert _result(report, "keel-core-dependency").ok
    assert _result(report, "app-factory").ok
    assert _result(report, "deny-by-default-authz").ok


def test_ts_reference_service_passes_every_hard_check() -> None:
    report = check_service(REPO / "services" / "reference-service-nest", CONTRACT)
    hard_failures = [r for r in report.results if not r.ok and not r.advisory]
    assert not hard_failures, f"TS reference should be conformant, failed: {hard_failures}"
    assert report.ok
    assert _result(report, "keel-core-dependency").ok
    assert _result(report, "app-factory").ok
    assert _result(report, "deny-by-default-authz").ok


def test_reference_service_passes_every_hard_check() -> None:
    report = check_service(REFERENCE, CONTRACT)
    hard_failures = [r for r in report.results if not r.ok and not r.advisory]
    assert not hard_failures, f"reference service should be conformant, failed: {hard_failures}"
    assert report.ok
    # The reference service is the template source, not a generated instance, so it is not
    # Copier-tracked; that is an advisory check and must not fail conformance.
    assert not _result(report, "template-tracked").ok
    assert _result(report, "template-tracked").advisory


def _write_service(root: Path, *, pyproject: str, source: str, answers: bool) -> Path:
    (root / "src" / "svc").mkdir(parents=True)
    (root / "pyproject.toml").write_text(pyproject, encoding="utf-8")
    (root / "src" / "svc" / "app.py").write_text(source, encoding="utf-8")
    if answers:
        (root / ".copier-answers.yml").write_text("_src_path: x\n", encoding="utf-8")
    return root


CONFORMANT_PYPROJECT = '[project]\nname = "svc"\ndependencies = ["keel-core>=0.1", "fastapi"]\n'
CONFORMANT_SOURCE = (
    "from keel_core.adapters.inbound.http import create_app\n"
    "from keel_core.config import BaseServiceConfig\n"
    "from keel_core.adapters.inbound.http import require_scopes\n"
)


def test_fully_wired_synthetic_service_passes(tmp_path: Path) -> None:
    svc = _write_service(
        tmp_path, pyproject=CONFORMANT_PYPROJECT, source=CONFORMANT_SOURCE, answers=True
    )
    assert check_service(svc, CONTRACT).ok


def test_missing_keel_core_dependency_fails(tmp_path: Path) -> None:
    svc = _write_service(
        tmp_path,
        pyproject='[project]\nname = "svc"\ndependencies = ["fastapi"]\n',
        source=CONFORMANT_SOURCE,
        answers=True,
    )
    report = check_service(svc, CONTRACT)
    assert not report.ok
    assert not _result(report, "keel-core-dependency").ok


def test_unguarded_routes_and_missing_app_factory_fail(tmp_path: Path) -> None:
    svc = _write_service(
        tmp_path,
        pyproject=CONFORMANT_PYPROJECT,
        source="from fastapi import FastAPI\napp = FastAPI()\n",
        answers=True,
    )
    report = check_service(svc, CONTRACT)
    assert not _result(report, "app-factory").ok
    assert not _result(report, "typed-config").ok
    assert not _result(report, "deny-by-default-authz").ok


def test_untracked_service_flags_template_tracked(tmp_path: Path) -> None:
    svc = _write_service(
        tmp_path, pyproject=CONFORMANT_PYPROJECT, source=CONFORMANT_SOURCE, answers=False
    )
    report = check_service(svc, CONTRACT)
    assert not _result(report, "template-tracked").ok


def test_unknown_contract_version_fails(tmp_path: Path) -> None:
    svc = _write_service(
        tmp_path, pyproject=CONFORMANT_PYPROJECT, source=CONFORMANT_SOURCE, answers=True
    )
    bad = tmp_path / "bad.yaml"
    bad.write_text("apiVersion: other.dev/v9\nkind: PlatformContract\n", encoding="utf-8")
    assert not _result(check_service(svc, bad), "contract").ok


def test_markers_only_in_comments_or_docstrings_do_not_count(tmp_path: Path) -> None:
    # The wiring markers appear ONLY in a docstring (and keel-core only in a pyproject comment);
    # comment/docstring stripping + manifest parsing must reject this, not greenlight it.
    (tmp_path / "src" / "svc").mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "x"\n# keel-core would be nice but is not used here\n'
        'dependencies = ["fastapi"]\n',
        encoding="utf-8",
    )
    (tmp_path / "src" / "svc" / "app.py").write_text(
        '"""Does NOT use: from keel_core.adapters.inbound.http import create_app, '
        'BaseServiceConfig, or require_scopes - these names are only in this docstring."""\n'
        "from fastapi import FastAPI\n",
        encoding="utf-8",
    )
    (tmp_path / ".copier-answers.yml").write_text("_src_path: x\n", encoding="utf-8")
    report = check_service(tmp_path, CONTRACT)
    assert not report.ok
    assert not _result(report, "keel-core-dependency").ok
    assert not _result(report, "app-factory").ok
    assert not _result(report, "typed-config").ok
    assert not _result(report, "deny-by-default-authz").ok


def test_ts_getscopes_identifier_does_not_satisfy_authz(tmp_path: Path) -> None:
    # A NestJS service with a getScopes() helper but NO @Scopes decorator must fail authz: the
    # dropped "Scopes(" marker used to match getScopes(/hasScopes( and greenlight an unguarded app.
    (tmp_path / "src").mkdir()
    (tmp_path / "package.json").write_text(
        '{"name":"x","dependencies":{"@keel/core":"workspace:*"}}', encoding="utf-8"
    )
    (tmp_path / "src" / "app.ts").write_text(
        "import { KeelCoreModule, loadConfig } from '@keel/core';\n"
        "function scopesFor(u: User) { return getScopes(u); }\n",
        encoding="utf-8",
    )
    report = check_service(tmp_path, CONTRACT)
    assert not _result(report, "deny-by-default-authz").ok


def _result(report, check_id):  # type: ignore[no-untyped-def]
    return next(r for r in report.results if r.check_id == check_id)
