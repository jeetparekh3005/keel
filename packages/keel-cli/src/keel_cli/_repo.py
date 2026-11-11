"""Locate the keel contract and service templates relative to a working directory.

In-tree (the dogfood and the monorepo), the repo root is the directory holding ``platform.yaml``
and the templates live under ``<root>/templates/service-<language>``. In the polyrepo future a
generated service carries its own ``platform.yaml`` and Copier fetches templates from a git URL;
both locations are overridable with explicit paths on the CLI, so this discovery is a convenience,
not a hard dependency on the monorepo layout.
"""

from __future__ import annotations

from pathlib import Path


def find_repo_root(start: Path) -> Path | None:
    """Return the nearest ancestor of ``start`` that holds ``platform.yaml`` (the repo root)."""
    start = start.resolve()
    for directory in (start, *start.parents):
        if (directory / "platform.yaml").is_file():
            return directory
    return None


def find_contract(start: Path) -> Path | None:
    """Return the ``platform.yaml`` governing ``start``, or ``None`` if not inside a keel tree."""
    root = find_repo_root(start)
    return root / "platform.yaml" if root is not None else None


def find_template(language: str, start: Path) -> Path | None:
    """Return the in-tree template dir for ``language``, or ``None`` if unavailable."""
    root = find_repo_root(start)
    if root is None:
        return None
    template = root / "templates" / f"service-{language}"
    return template if (template / "copier.yml").is_file() else None
