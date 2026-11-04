from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect

import reference_service.adapters.outbound.persistence  # noqa: F401  (register ItemRecord)
from keel_core.adapters.outbound.persistence import Entity

_SERVICE_ROOT = Path(__file__).resolve().parents[1]

# compare_metadata diff kinds that mean the ORM and the migrations disagree
# structurally (ignoring sqlite type-affinity noise).
_STRUCTURAL = {"add_table", "remove_table", "add_column", "remove_column"}


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
    structural = [d for d in diffs if isinstance(d, tuple) and d and d[0] in _STRUCTURAL]
    assert not structural, f"ORM/migration drift: {structural}"
