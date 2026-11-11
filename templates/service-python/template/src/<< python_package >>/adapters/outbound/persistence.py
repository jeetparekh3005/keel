"""SQLAlchemy persistence for << aggregate_plural >>: ORM record + repository mapping to the domain."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from keel_core.adapters.outbound.persistence import Entity
from << python_package >>.domain.<< aggregate >> import << aggregate_pascal >>


class << aggregate_pascal >>Record(Entity):
    """ORM mapping for an << aggregate >> row."""

    __tablename__ = "<< aggregate_plural >>"

    id: Mapped[str] = mapped_column(primary_key=True)
    name: Mapped[str]


class Sql<< aggregate_pascal >>Repository:
    """<< aggregate_pascal >>Repository backed by SQLAlchemy; maps between ORM records and domain << aggregate_plural >>."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to an active session."""
        self._session = session

    async def add(self, << aggregate >>: << aggregate_pascal >>) -> None:
        """Persist a new << aggregate >>."""
        self._session.add(<< aggregate_pascal >>Record(id=<< aggregate >>.id, name=<< aggregate >>.name))

    async def get(self, << aggregate >>_id: str) -> << aggregate_pascal >> | None:
        """Return the << aggregate >>, or None if absent."""
        record = await self._session.get(<< aggregate_pascal >>Record, << aggregate >>_id)
        return << aggregate_pascal >>(id=record.id, name=record.name) if record is not None else None

    async def list_all(self, *, limit: int = 50, offset: int = 0) -> Sequence[<< aggregate_pascal >>]:
        """Return a page of << aggregate_plural >> (ordered by id for stable paging)."""
        statement = select(<< aggregate_pascal >>Record).order_by(<< aggregate_pascal >>Record.id).limit(limit).offset(offset)
        result = await self._session.execute(statement)
        return [<< aggregate_pascal >>(id=record.id, name=record.name) for record in result.scalars().all()]
