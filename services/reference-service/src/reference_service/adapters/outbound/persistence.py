"""SQLAlchemy persistence for items: ORM record + repository mapping to the domain."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from keel_core.adapters.outbound.persistence import Entity
from reference_service.domain.item import Item


class ItemRecord(Entity):
    """ORM mapping for an item row."""

    __tablename__ = "items"

    id: Mapped[str] = mapped_column(primary_key=True)
    name: Mapped[str]


class SqlItemRepository:
    """ItemRepository backed by SQLAlchemy; maps between ORM records and domain items."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to an active session."""
        self._session = session

    async def add(self, item: Item) -> None:
        """Persist a new item."""
        self._session.add(ItemRecord(id=item.id, name=item.name))

    async def get(self, item_id: str) -> Item | None:
        """Return the item, or None if absent."""
        record = await self._session.get(ItemRecord, item_id)
        return Item(id=record.id, name=record.name) if record is not None else None

    async def list_all(self, *, limit: int = 50, offset: int = 0) -> Sequence[Item]:
        """Return a page of items (ordered by id for stable paging)."""
        statement = select(ItemRecord).order_by(ItemRecord.id).limit(limit).offset(offset)
        result = await self._session.execute(statement)
        return [Item(id=record.id, name=record.name) for record in result.scalars().all()]
