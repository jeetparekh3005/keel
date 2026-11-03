"""Generic SQLAlchemy repository base implementing the Repository port."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from keel_core.adapters.outbound.persistence.base import Entity


class SqlAlchemyRepository[EntityT: Entity, IdT]:
    """Repository base for a single mapped entity. Subclasses set ``model``.

    Example:
        class UserRepository(SqlAlchemyRepository[User, UUID]):
            model = User
    """

    model: type[EntityT]

    def __init__(self, session: AsyncSession) -> None:
        """Bind the repository to an active session."""
        self._session = session

    async def add(self, entity: EntityT) -> None:
        """Stage ``entity`` for insertion."""
        self._session.add(entity)

    async def get(self, entity_id: IdT) -> EntityT | None:
        """Return the entity with ``entity_id``, or None."""
        return await self._session.get(self.model, entity_id)

    async def list_all(self) -> Sequence[EntityT]:
        """Return all entities of this type."""
        result = await self._session.execute(select(self.model))
        return result.scalars().all()

    async def delete(self, entity: EntityT) -> None:
        """Stage ``entity`` for deletion."""
        await self._session.delete(entity)
