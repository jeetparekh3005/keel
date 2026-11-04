import pytest
from sqlalchemy import select
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.pool import StaticPool

from keel_core.adapters.outbound.persistence import Database, Entity, UnitOfWork


class _Thing(Entity):
    __tablename__ = "things"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]


@pytest.fixture
async def db():
    # StaticPool shares one in-memory connection across sessions.
    database = Database("sqlite+aiosqlite://", poolclass=StaticPool)
    await database.create_all()
    yield database
    await database.dispose()


async def test_ping_returns_true(db):
    assert await db.ping() is True


async def test_unit_of_work_commits_and_reads_back(db):
    # keel-core provides the Database + UnitOfWork plumbing; a service owns its
    # repository and the ORM<->domain mapping. Here we drive the session directly.
    async with UnitOfWork(db.session_factory) as session:
        session.add(_Thing(id=1, name="alpha"))

    async with UnitOfWork(db.session_factory) as session:
        fetched = await session.get(_Thing, 1)
        assert fetched is not None
        assert fetched.name == "alpha"
        rows = (await session.execute(select(_Thing))).scalars().all()
        assert len(rows) == 1

    async with UnitOfWork(db.session_factory) as session:
        thing = await session.get(_Thing, 1)
        assert thing is not None
        await session.delete(thing)

    async with UnitOfWork(db.session_factory) as session:
        assert await session.get(_Thing, 1) is None


async def _add_then_fail(db):
    async with UnitOfWork(db.session_factory) as session:
        session.add(_Thing(id=2, name="ghost"))
        msg = "boom"
        raise RuntimeError(msg)


async def test_rollback_on_error_discards_changes(db):
    with pytest.raises(RuntimeError):
        await _add_then_fail(db)

    async with UnitOfWork(db.session_factory) as session:
        assert await session.get(_Thing, 2) is None
