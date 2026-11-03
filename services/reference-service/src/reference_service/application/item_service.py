"""Item use cases."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import uuid4

from keel_core.domain.errors import NotFound
from reference_service.domain.item import Item, ItemRepository


class ItemService:
    """Create, fetch, and list items via the repository port."""

    def __init__(self, repository: ItemRepository) -> None:
        """Bind to an ItemRepository implementation."""
        self._repository = repository

    async def create(self, name: str) -> Item:
        """Create and persist a new item."""
        item = Item(id=uuid4().hex, name=name)
        await self._repository.add(item)
        return item

    async def get(self, item_id: str) -> Item:
        """Return the item, raising ``NotFound`` if it does not exist."""
        item = await self._repository.get(item_id)
        if item is None:
            msg = f"item {item_id} not found"
            raise NotFound(msg)
        return item

    async def list(self, *, limit: int = 50, offset: int = 0) -> Sequence[Item]:
        """Return a page of items."""
        return await self._repository.list_all(limit=limit, offset=offset)
