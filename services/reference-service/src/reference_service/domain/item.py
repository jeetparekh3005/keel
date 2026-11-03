"""Item aggregate and its repository port (pure domain; no ORM, no I/O)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class Item:
    """An item owned by the service."""

    id: str
    name: str


class ItemRepository(Protocol):
    """Persistence operations for :class:`Item` (implemented by an adapter)."""

    async def add(self, item: Item) -> None:
        """Persist a new item."""
        ...

    async def get(self, item_id: str) -> Item | None:
        """Return the item, or None if absent."""
        ...

    async def list_all(self) -> Sequence[Item]:
        """Return all items."""
        ...
