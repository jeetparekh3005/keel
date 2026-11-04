import asyncio
import os

import pytest
from sqlalchemy.exc import IntegrityError

from keel_core.adapters.outbound.persistence import Database, UnitOfWork
from reference_service.adapters.outbound.persistence import SqlItemRepository
from reference_service.domain.item import Item

_PG_URL = os.environ.get("KEEL_TEST_DATABASE_URL")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(_PG_URL is None, reason="KEEL_TEST_DATABASE_URL not set"),
]


async def _database() -> Database:
    database = Database(_PG_URL, pool_pre_ping=True)
    await database.create_all()
    return database


async def test_item_roundtrip_on_postgres():
    database = await _database()
    try:
        async with UnitOfWork(database.session_factory) as session:
            await SqlItemRepository(session).add(Item(id="pg-1", name="postgres"))
        async with UnitOfWork(database.session_factory) as session:
            fetched = await SqlItemRepository(session).get("pg-1")
            assert fetched is not None
            assert fetched.name == "postgres"
    finally:
        await database.dispose()


async def test_duplicate_primary_key_raises_integrity_error():
    database = await _database()
    try:
        async with UnitOfWork(database.session_factory) as session:
            await SqlItemRepository(session).add(Item(id="pg-dup", name="first"))
        with pytest.raises(IntegrityError):
            async with UnitOfWork(database.session_factory) as session:
                await SqlItemRepository(session).add(Item(id="pg-dup", name="second"))
    finally:
        await database.dispose()


async def _add_then_fail(database: Database) -> None:
    async with UnitOfWork(database.session_factory) as session:
        await SqlItemRepository(session).add(Item(id="pg-rollback", name="ghost"))
        msg = "boom"
        raise RuntimeError(msg)


async def test_rollback_discards_changes_on_postgres():
    database = await _database()
    try:
        with pytest.raises(RuntimeError):
            await _add_then_fail(database)
        async with UnitOfWork(database.session_factory) as session:
            assert await SqlItemRepository(session).get("pg-rollback") is None
    finally:
        await database.dispose()


async def test_concurrent_sessions_commit_independently():
    database = await _database()

    async def _insert(index: int) -> None:
        async with UnitOfWork(database.session_factory) as session:
            await SqlItemRepository(session).add(Item(id=f"pg-cc-{index}", name=str(index)))

    try:
        await asyncio.gather(*(_insert(i) for i in range(5)))
        async with UnitOfWork(database.session_factory) as session:
            repo = SqlItemRepository(session)
            for i in range(5):
                assert await repo.get(f"pg-cc-{i}") is not None
    finally:
        await database.dispose()
