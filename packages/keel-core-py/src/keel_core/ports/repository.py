"""Repository port: persistence abstraction the domain depends on (not an ORM)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol


class Repository[EntityT, IdT](Protocol):
    """Persistence operations for a single aggregate type."""

    async def add(self, entity: EntityT) -> None:
        """Stage ``entity`` for insertion."""
        ...

    async def get(self, entity_id: IdT) -> EntityT | None:
        """Return the entity with ``entity_id``, or None."""
        ...

    async def list_all(self) -> Sequence[EntityT]:
        """Return all entities of this type."""
        ...

    async def delete(self, entity: EntityT) -> None:
        """Stage ``entity`` for deletion."""
        ...
