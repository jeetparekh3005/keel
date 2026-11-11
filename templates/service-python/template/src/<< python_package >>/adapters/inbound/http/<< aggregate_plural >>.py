"""HTTP router for << aggregate_plural >> (driving adapter) calling the << aggregate_pascal >>Service use cases."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import cast

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from keel_core.adapters.inbound.http import require_scopes
from keel_core.adapters.outbound.persistence import Database, UnitOfWork
from << python_package >>.application.<< aggregate >>_service import << aggregate_pascal >>Service

# The composition root injects how to build an << aggregate_pascal >>Service for a session, so this
# driving adapter never imports the concrete outbound repository (hexagonal: the
# inbound adapter depends on the use case, not on a driven adapter).
<< aggregate_pascal >>ServiceFactory = Callable[[AsyncSession], << aggregate_pascal >>Service]

# URL-versioned: breaking changes ship under a new prefix (/v2) without disturbing /v1.
router = APIRouter(prefix="/v1/<< aggregate_plural >>", tags=["<< aggregate_plural >>"])


class << aggregate_pascal >>In(BaseModel):
    """Request body for creating an << aggregate >>."""

    name: str = Field(min_length=1, max_length=200)


class << aggregate_pascal >>Out(BaseModel):
    """<< aggregate_pascal >> representation returned to clients."""

    id: str
    name: str


class Page(BaseModel):
    """Pagination metadata for a list response."""

    limit: int
    offset: int
    count: int


class << aggregate_pascal >>ListOut(BaseModel):
    """Envelope for a page of << aggregate_plural >> (never a bare array, so metadata has a home)."""

    << aggregate_plural >>: list[<< aggregate_pascal >>Out]
    page: Page


async def _session(request: Request) -> AsyncIterator[AsyncSession]:
    database: Database = request.app.state.database
    async with UnitOfWork(database.session_factory) as session:
        yield session


def _service(request: Request, session: AsyncSession = Depends(_session)) -> << aggregate_pascal >>Service:
    # Resolve the use case through the factory the composition root wired onto
    # app.state; the concrete repository adapter is named only there.
    factory = cast("<< aggregate_pascal >>ServiceFactory", request.app.state.<< aggregate >>_service_factory)
    return factory(session)


@router.post("", status_code=201, dependencies=[Depends(require_scopes("<< scope_prefix >>:write"))])
async def create_<< aggregate >>(
    body: << aggregate_pascal >>In, response: Response, service: << aggregate_pascal >>Service = Depends(_service)
) -> << aggregate_pascal >>Out:
    """Create an << aggregate >> (requires scope ``<< scope_prefix >>:write``); sets the ``Location`` header."""
    << aggregate >> = await service.create(body.name)
    response.headers["Location"] = f"{router.prefix}/{<< aggregate >>.id}"
    return << aggregate_pascal >>Out(id=<< aggregate >>.id, name=<< aggregate >>.name)


@router.get("/{<< aggregate >>_id}", dependencies=[Depends(require_scopes("<< scope_prefix >>:read"))])
async def get_<< aggregate >>(<< aggregate >>_id: str, service: << aggregate_pascal >>Service = Depends(_service)) -> << aggregate_pascal >>Out:
    """Fetch an << aggregate >> by id (404 if missing; requires scope ``<< scope_prefix >>:read``)."""
    << aggregate >> = await service.get(<< aggregate >>_id)
    return << aggregate_pascal >>Out(id=<< aggregate >>.id, name=<< aggregate >>.name)


@router.get("", dependencies=[Depends(require_scopes("<< scope_prefix >>:read"))])
async def list_<< aggregate_plural >>(
    service: << aggregate_pascal >>Service = Depends(_service),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> << aggregate_pascal >>ListOut:
    """List << aggregate_plural >> with pagination (requires scope ``<< scope_prefix >>:read``)."""
    << aggregate_plural >> = await service.list(limit=limit, offset=offset)
    rows = [<< aggregate_pascal >>Out(id=<< aggregate >>.id, name=<< aggregate >>.name) for << aggregate >> in << aggregate_plural >>]
    return << aggregate_pascal >>ListOut(<< aggregate_plural >>=rows, page=Page(limit=limit, offset=offset, count=len(rows)))
