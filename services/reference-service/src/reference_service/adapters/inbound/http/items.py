"""HTTP router for items (driving adapter) calling the ItemService use cases."""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from keel_core.adapters.outbound.persistence import Database, UnitOfWork
from reference_service.adapters.outbound.persistence import SqlItemRepository
from reference_service.application.item_service import ItemService

router = APIRouter(prefix="/items", tags=["items"])


class ItemIn(BaseModel):
    """Request body for creating an item."""

    name: str


class ItemOut(BaseModel):
    """Item representation returned to clients."""

    id: str
    name: str


async def _session(request: Request) -> AsyncIterator[AsyncSession]:
    database: Database = request.app.state.database
    async with UnitOfWork(database.session_factory) as session:
        yield session


def _service(session: AsyncSession) -> ItemService:
    return ItemService(SqlItemRepository(session))


@router.post("", status_code=201)
async def create_item(body: ItemIn, session: AsyncSession = Depends(_session)) -> ItemOut:
    """Create an item."""
    item = await _service(session).create(body.name)
    return ItemOut(id=item.id, name=item.name)


@router.get("/{item_id}")
async def get_item(item_id: str, session: AsyncSession = Depends(_session)) -> ItemOut:
    """Fetch an item by id (404 if missing)."""
    item = await _service(session).get(item_id)
    return ItemOut(id=item.id, name=item.name)


@router.get("")
async def list_items(session: AsyncSession = Depends(_session)) -> list[ItemOut]:
    """List all items."""
    items = await _service(session).list()
    return [ItemOut(id=item.id, name=item.name) for item in items]
