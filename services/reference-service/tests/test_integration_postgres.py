import os

import pytest

from keel_core.adapters.outbound.persistence import Database, UnitOfWork
from reference_service.adapters.outbound.persistence import SqlItemRepository
from reference_service.domain.item import Item

_PG_URL = os.environ.get("KEEL_TEST_DATABASE_URL")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(_PG_URL is None, reason="KEEL_TEST_DATABASE_URL not set"),
]


async def test_item_roundtrip_on_postgres():
    database = Database(_PG_URL, pool_pre_ping=True)
    await database.create_all()
    try:
        async with UnitOfWork(database.session_factory) as session:
            await SqlItemRepository(session).add(Item(id="pg-1", name="postgres"))
        async with UnitOfWork(database.session_factory) as session:
            fetched = await SqlItemRepository(session).get("pg-1")
            assert fetched is not None
            assert fetched.name == "postgres"
    finally:
        await database.dispose()
