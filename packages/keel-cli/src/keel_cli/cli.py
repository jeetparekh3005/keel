"""The ``keel`` CLI: a thin Copier wrapper plus a static ``platform.yaml`` conformance check.

Copier does the templating (``copier copy`` / ``copier update``); keel adds friendly entry points
and a fast conformance gate (ADR-0021). This is intentionally not a from-scratch generator: richer
subcommands (``doctor``, ``list``, pinning policy) are deferred.
"""

from __future__ import annotations

from pathlib import Path

import click

from keel_cli import _repo
from keel_cli.conformance import check_service

SUPPORTED_LANGUAGES = ("python",)


@click.group()
@click.version_option(package_name="keel-cli", prog_name="keel")
def main() -> None:
    """Scaffold and maintain keel services."""


@main.command()
@click.argument("destination", type=click.Path(path_type=Path))
@click.option(
    "--language",
    "-l",
    type=click.Choice(SUPPORTED_LANGUAGES),
    default="python",
    show_default=True,
    help="Service language (selects the template).",
)
@click.option(
    "--template",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default=None,
    help="Template directory (overrides the in-tree templates/service-<language>).",
)
@click.option(
    "--data",
    "-d",
    multiple=True,
    metavar="KEY=VALUE",
    help="Pre-seed a Copier answer (repeatable). Unseeded questions are prompted.",
)
@click.option("--defaults", is_flag=True, help="Accept template defaults for unseeded questions.")
def new(
    destination: Path,
    language: str,
    template: Path | None,
    data: tuple[str, ...],
    *,
    defaults: bool,
) -> None:
    """Scaffold a new service into DESTINATION (``copier copy``), then check it."""
    from copier import run_copy

    chosen = template or _repo.find_template(language, Path.cwd())
    if chosen is None:
        message = (
            f"no template for language {language!r}; run inside a keel checkout or pass --template"
        )
        raise click.ClickException(message)
    run_copy(str(chosen), str(destination), data=_parse_data(data), defaults=defaults, unsafe=True)
    click.echo(f"scaffolded {language} service at {destination}")
    _echo_check(destination, soft=True)


@main.command()
@click.argument(
    "service_dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default=".",
)
def update(service_dir: Path) -> None:  # pragma: no cover - thin copier passthrough
    """Re-apply the template at its newest version into SERVICE_DIR (``copier update``).

    Exercised end to end by the round-trip CI (issue #372): ``copier update`` needs a
    git-tagged template and a committed ``.copier-answers.yml`` to diff against, which a unit
    test cannot cheaply stand up. The body is a direct passthrough to ``copier.run_update``.
    """
    from copier import run_update

    run_update(str(service_dir), defaults=False, unsafe=True)
    click.echo(f"updated {service_dir}")
    _echo_check(service_dir, soft=True)


@main.command()
@click.argument(
    "service_dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default=".",
)
@click.option(
    "--contract",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=None,
    help="platform.yaml to check against (default: discovered by walking up from SERVICE_DIR).",
)
def check(service_dir: Path, contract: Path | None) -> None:
    """Statically check SERVICE_DIR against the platform.yaml contract."""
    contract_path = contract or _repo.find_contract(service_dir)
    if contract_path is None:
        message = "no platform.yaml found; run inside a keel checkout or pass --contract"
        raise click.ClickException(message)
    if not _echo_check(service_dir, soft=False, contract_path=contract_path):
        raise SystemExit(1)
    click.echo("conformance: all static checks passed")


def _parse_data(pairs: tuple[str, ...]) -> dict[str, str]:
    answers: dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            message = f"--data expects KEY=VALUE, got {pair!r}"
            raise click.ClickException(message)
        key, value = pair.split("=", 1)
        answers[key] = value
    return answers


def _echo_check(service_dir: Path, *, soft: bool, contract_path: Path | None = None) -> bool:
    """Print the conformance report for ``service_dir``; return True when all checks passed.

    ``soft`` (post-generation) prints a hint and returns when no contract is discoverable rather
    than erroring, so ``keel new`` into a standalone directory still succeeds.
    """
    resolved = contract_path or _repo.find_contract(service_dir)
    if resolved is None:
        if not soft:
            message = "no platform.yaml found to check against"
            raise click.ClickException(message)
        click.echo("conformance: skipped (no platform.yaml found; run `keel check --contract ...`)")
        return True
    report = check_service(service_dir, resolved)
    for result in report.results:
        if result.ok:
            mark = "ok  "
        elif result.advisory:
            mark = "warn"
        else:
            mark = "FAIL"
        click.echo(f"[{mark}] {result.check_id}: {result.detail}")
    return report.ok
