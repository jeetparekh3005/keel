from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect

import reference_service.adapters.outbound.persistence  # noqa: F401  (register ItemRecord)
from keel_core.adapters.outbound.persistence import Entity

_SERVICE_ROOT = Path(__file__).resolve().parents[1]

# compare_metadata diff kinds that mean the ORM and the migrations disagree: table and
# column existence, plus column nullability/type/default. The modify_* kinds arrive from
# compare_metadata as nested lists (one per column), so they must be flattened (see
# _flatten) - otherwise a NOT NULL flip or a type change slips through silently.
_STRUCTURAL = {
    "add_table",
    "remove_table",
    "add_column",
    "remove_column",
    "modify_nullable",
    "modify_type",
    "modify_default",
}

# Scope the drift check to this service's own tables: Entity.metadata is a shared
# declarative base, and other packages' test models (e.g. keel-core's) register
# their tables on it during a full test run. A real drift on a service table
# (a new/removed column, or the table itself) is still caught.
_OWNED_TABLES = {"items"}


def _flatten(diffs: list) -> list:
    # compare_metadata returns table-level ops as tuples and column-level modify ops as
    # nested lists of tuples; flatten one level so both are inspected.
    flat: list = []
    for diff in diffs:
        if isinstance(diff, list):
            flat.extend(diff)
        else:
            flat.append(diff)
    return flat


def _diff_table(diff: tuple) -> str | None:
    kind = diff[0]
    if kind in {"add_table", "remove_table"}:
        return diff[1].name
    if kind in {"add_column", "remove_column"}:
        return diff[2]
    if kind.startswith("modify_"):
        # modify_* diffs carry the table name at index 2 and the column at index 3.
        return diff[2]
    return None


def _config(db_path: Path) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(_SERVICE_ROOT / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    return cfg


def test_migrations_create_items_table(tmp_path):
    cfg = _config(tmp_path / "migrated.db")
    command.upgrade(cfg, "head")
    engine = create_engine(cfg.get_main_option("sqlalchemy.url"))
    try:
        assert "items" in inspect(engine).get_table_names()
    finally:
        engine.dispose()


def test_downgrade_removes_items_table(tmp_path):
    cfg = _config(tmp_path / "down.db")
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    engine = create_engine(cfg.get_main_option("sqlalchemy.url"))
    try:
        assert "items" not in inspect(engine).get_table_names()
    finally:
        engine.dispose()


def test_no_pending_migration_drift(tmp_path):
    # Head schema must match the ORM metadata: a model change without a matching
    # migration (a new/removed column or table) fails here.
    cfg = _config(tmp_path / "drift.db")
    command.upgrade(cfg, "head")
    engine = create_engine(cfg.get_main_option("sqlalchemy.url"))
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(connection)
            diffs = compare_metadata(context, Entity.metadata)
    finally:
        engine.dispose()
    structural = [
        d
        for d in _flatten(diffs)
        if isinstance(d, tuple) and d and d[0] in _STRUCTURAL and _diff_table(d) in _OWNED_TABLES
    ]
    assert not structural, f"ORM/migration drift: {structural}"
