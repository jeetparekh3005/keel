"""The `keel update` round-trip: a template change propagates while local edits survive (#372).

This is the Tier-2 propagation guarantee (ADR-0021). It stands up a throwaway git-repo copy of
the real ``templates/service-python``, generates a service from tag v1, makes a team-owned local
edit, advances the template to v2, then runs ``keel update`` and asserts the v2 change landed
(rendered with the service's stored answers) and the local edit was preserved. It exercises the
actual template + its custom ``<< >>`` delimiters + the shipped ``.copier-answers.yml`` through
Copier's 3-way merge, which is where update-specific breakage would hide.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from click.testing import CliRunner
from copier import run_copy

from keel_cli.cli import main

REPO = Path(__file__).resolve().parents[3]
TEMPLATE = REPO / "templates" / "service-python"


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=ci@keel.dev", "-c", "user.name=keel ci", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def test_keel_update_propagates_template_change_and_preserves_local_edits(tmp_path: Path) -> None:
    work = tmp_path.resolve()

    # A throwaway git-repo copy of the real template, tagged v1.0.0.
    template = work / "template"
    shutil.copytree(TEMPLATE, template)
    _git(template, "init", "-q")
    _git(template, "add", "-A")
    _git(template, "commit", "-qm", "v1")
    _git(template, "tag", "v1.0.0")

    # Generate a service from v1 (records _commit: v1.0.0), then make it a git repo.
    service = work / "orders-service"
    run_copy(
        str(template),
        str(service),
        vcs_ref="v1.0.0",
        data={"service_name": "Orders Service", "aggregate": "order"},
        defaults=True,
        unsafe=True,
    )
    assert "_commit: v1.0.0" in (service / ".copier-answers.yml").read_text(encoding="utf-8")
    _git(service, "init", "-q")
    _git(service, "add", "-A")
    _git(service, "commit", "-qm", "generated")

    # A team-owned local edit in a region the template never touches.
    readme = service / "README.md"
    marker = "<!-- LOCAL EDIT: team-owned note, must survive keel update -->"
    readme.write_text(readme.read_text(encoding="utf-8") + f"\n{marker}\n", encoding="utf-8")
    _git(service, "add", "-A")
    _git(service, "commit", "-qm", "local edit")

    # Advance the template: add a new file (rendered with service answers), tag v2.0.0.
    (template / "template" / "SECURITY.md").write_text(
        "# Security policy\n\nReport to security@<< service_slug >>.example\n", encoding="utf-8"
    )
    _git(template, "add", "-A")
    _git(template, "commit", "-qm", "v2: add SECURITY.md")
    _git(template, "tag", "v2.0.0")

    # keel update --defaults: non-interactive, reuses stored answers, applies template changes.
    result = CliRunner().invoke(main, ["update", str(service), "--defaults"])
    assert result.exit_code == 0, result.output

    security = service / "SECURITY.md"
    assert security.is_file(), "the v2 template change (SECURITY.md) should propagate"
    assert "security@orders-service.example" in security.read_text(encoding="utf-8"), (
        "the propagated file should be rendered with the service's stored answers"
    )
    assert marker in readme.read_text(encoding="utf-8"), "the local edit must be preserved"
    assert "_commit: v2.0.0" in (service / ".copier-answers.yml").read_text(encoding="utf-8")
