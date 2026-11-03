from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

_SERVICE_ROOT = Path(__file__).resolve().parents[1]


def test_migrations_create_items_table(tmp_path):
    db_path = tmp_path / "migrated.db"
    cfg = Config()
    cfg.set_main_option("script_location", str(_SERVICE_ROOT / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")

    command.upgrade(cfg, "head")

    engine = create_engine(f"sqlite:///{db_path}")
    try:
        assert "items" in inspect(engine).get_table_names()
    finally:
        engine.dispose()
