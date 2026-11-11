"""CLI tests: `check` on the real reference service, and `new` generates a conformant service."""

from __future__ import annotations

from pathlib import Path

from click.testing import CliRunner

from keel_cli.cli import main
from keel_cli.conformance import check_service

REPO = Path(__file__).resolve().parents[3]
REFERENCE = REPO / "services" / "reference-service"
CONTRACT = REPO / "platform.yaml"
TEMPLATE = REPO / "templates" / "service-python"


def test_version() -> None:
    result = CliRunner().invoke(main, ["--version"])
    assert result.exit_code == 0
    assert "keel" in result.output


def test_check_passes_on_reference_service() -> None:
    result = CliRunner().invoke(main, ["check", str(REFERENCE), "--contract", str(CONTRACT)])
    assert result.exit_code == 0, result.output
    assert "all static checks passed" in result.output


def test_check_fails_on_nonconformant_service(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "x"\ndependencies = []\n', encoding="utf-8"
    )
    (tmp_path / "src").mkdir()
    result = CliRunner().invoke(main, ["check", str(tmp_path), "--contract", str(CONTRACT)])
    assert result.exit_code == 1
    assert "FAIL" in result.output


def test_new_scaffolds_a_conformant_service(tmp_path: Path) -> None:
    dest = tmp_path / "orders-service"
    result = CliRunner().invoke(
        main,
        [
            "new",
            str(dest),
            "--template",
            str(TEMPLATE),
            "--defaults",
            "-d",
            "service_name=Orders Service",
            "-d",
            "aggregate=order",
        ],
    )
    assert result.exit_code == 0, result.output
    assert (dest / ".copier-answers.yml").is_file()
    # The generated tree is checked against the real contract (discovery is skipped outside the
    # repo tree, so assert directly).
    assert check_service(dest, CONTRACT).ok
    # Answers drove the aggregate rename end to end.
    assert (dest / "src" / "orders_service" / "domain" / "order.py").is_file()
