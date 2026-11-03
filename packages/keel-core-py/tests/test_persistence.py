import pytest
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.pool import StaticPool

from keel_core.adapters.outbound.persistence import (
    Database,
    Entity,
    SqlAlchemyRepository,
    UnitOfWork,
)


class _Thing(Entity):
    __tablename__ = "things"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]


class _ThingRepo(SqlAlchemyRepository[_Thing, int]):
    model = _Thing


@pytest.fixture
async def db():
    # StaticPool shares one in-memory connection across sessions.
    database = Database("sqlite+aiosqlite://", poolclass=StaticPool)
    await database.create_all()
    yield database
    await database.dispose()


async def test_ping_returns_true(db):
    assert await db.ping() is True


async def test_crud_roundtrip(db):
    async with UnitOfWork(db.session_factory) as session:
        await _ThingRepo(session).add(_Thing(id=1, name="alpha"))

    async with UnitOfWork(db.session_factory) as session:
        repo = _ThingRepo(session)
        fetched = await repo.get(1)
        assert fetched is not None
        assert fetched.name == "alpha"
        assert len(await repo.list_all()) == 1

    async with UnitOfWork(db.session_factory) as session:
        repo = _ThingRepo(session)
        thing = await repo.get(1)
        assert thing is not None
        await repo.delete(thing)

    async with UnitOfWork(db.session_factory) as session:
        assert await _ThingRepo(session).get(1) is None


async def _add_then_fail(db):
    async with UnitOfWork(db.session_factory) as session:
        await _ThingRepo(session).add(_Thing(id=2, name="ghost"))
        msg = "boom"
        raise RuntimeError(msg)


async def test_rollback_on_error_discards_changes(db):
    with pytest.raises(RuntimeError):
        await _add_then_fail(db)

    async with UnitOfWork(db.session_factory) as session:
        assert await _ThingRepo(session).get(2) is None
