"""HTTP router for items (driving adapter) calling the ItemService use cases."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import cast

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from keel_core.adapters.inbound.http import require_scopes
from keel_core.adapters.outbound.persistence import Database, UnitOfWork
from reference_service.application.item_service import ItemService

# The composition root injects how to build an ItemService for a session, so this
# driving adapter never imports the concrete outbound repository (hexagonal: the
# inbound adapter depends on the use case, not on a driven adapter).
ItemServiceFactory = Callable[[AsyncSession], ItemService]

# URL-versioned: breaking changes ship under a new prefix (/v2) without disturbing /v1.
router = APIRouter(prefix="/v1/items", tags=["items"])


class ItemIn(BaseModel):
    """Request body for creating an item."""

    name: str = Field(min_length=1, max_length=200)


class ItemOut(BaseModel):
    """Item representation returned to clients."""

    id: str
    name: str


class Page(BaseModel):
    """Pagination metadata for a list response."""

    limit: int
    offset: int
    count: int


class ItemListOut(BaseModel):
    """Envelope for a page of items (never a bare array, so metadata has a home)."""

    items: list[ItemOut]
    page: Page


async def _session(request: Request) -> AsyncIterator[AsyncSession]:
    database: Database = request.app.state.database
    async with UnitOfWork(database.session_factory) as session:
        yield session


def _service(request: Request, session: AsyncSession = Depends(_session)) -> ItemService:
    # Resolve the use case through the factory the composition root wired onto
    # app.state; the concrete repository adapter is named only there.
    factory = cast("ItemServiceFactory", request.app.state.item_service_factory)
    return factory(session)


@router.post("", status_code=201, dependencies=[Depends(require_scopes("items:write"))])
async def create_item(
    body: ItemIn, response: Response, service: ItemService = Depends(_service)
) -> ItemOut:
    """Create an item (requires scope ``items:write``); sets the ``Location`` header."""
    item = await service.create(body.name)
    response.headers["Location"] = f"{router.prefix}/{item.id}"
    return ItemOut(id=item.id, name=item.name)


@router.get("/{item_id}", dependencies=[Depends(require_scopes("items:read"))])
async def get_item(item_id: str, service: ItemService = Depends(_service)) -> ItemOut:
    """Fetch an item by id (404 if missing; requires scope ``items:read``)."""
    item = await service.get(item_id)
    return ItemOut(id=item.id, name=item.name)


@router.get("", dependencies=[Depends(require_scopes("items:read"))])
async def list_items(
    service: ItemService = Depends(_service),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> ItemListOut:
    """List items with pagination (requires scope ``items:read``)."""
    items = await service.list(limit=limit, offset=offset)
    rows = [ItemOut(id=item.id, name=item.name) for item in items]
    return ItemListOut(items=rows, page=Page(limit=limit, offset=offset, count=len(rows)))
