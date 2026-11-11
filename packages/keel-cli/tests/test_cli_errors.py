"""CLI error and edge-path tests: discovery failures, bad answers, and the soft post-gen check."""

from __future__ import annotations

from pathlib import Path

import pytest
from click.testing import CliRunner

from keel_cli.cli import main

REPO = Path(__file__).resolve().parents[3]
TEMPLATE = REPO / "templates" / "service-python"


def test_new_without_template_outside_a_keel_tree_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(main, ["new", "svc", "-d", "service_name=X", "-d", "aggregate=x"])
    assert result.exit_code != 0
    assert "no template for language" in result.output


def test_new_rejects_malformed_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(main, ["new", "svc", "--template", str(TEMPLATE), "-d", "nokey"])
    assert result.exit_code != 0
    assert "KEY=VALUE" in result.output


def test_new_outside_a_tree_still_scaffolds_and_soft_skips_the_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(
        main,
        ["new", "svc", "--template", str(TEMPLATE), "--defaults", "-d", "aggregate=order"],
    )
    assert result.exit_code == 0, result.output
    assert (tmp_path / "svc").is_dir()
    assert "conformance: skipped" in result.output


def test_check_without_a_discoverable_contract_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "svc").mkdir()
    result = CliRunner().invoke(main, ["check", "svc"])
    assert result.exit_code != 0
    assert "no platform.yaml found" in result.output
