"""Concrete gRPC ItemService servicer for the keel.reference.v1 contract (ADR-0022).

This wires the generated ``ItemServiceServicer`` to a small in-memory store. The
focus is the auth/mTLS posture, not persistence: deny-by-default authentication and
the per-method scope checks are enforced by the server factory's ``AuthInterceptor``
(``keel_core.adapters.inbound.rpc.server``), which runs before any method here and
publishes the caller on ``keel_core.context.principal_var``. The scope map a factory
must apply is exported as ``ITEM_SERVICE_REQUIRED_SCOPES`` so a caller wires the same
posture via ``create_server(required_scopes=...)``; the proto itself carries no scope
options (ADR-0022 option A1).
"""

from __future__ import annotations

import itertools
import threading
from typing import TYPE_CHECKING

import grpc

import keel_core.genproto  # noqa: F401  # side effect: puts the vendored stubs on sys.path
from keel.reference.v1 import item_pb2, item_pb2_grpc
from keel_core.context import principal_var
from keel_core.domain.errors import Unauthenticated

if TYPE_CHECKING:
    from keel_core.ports.auth import Principal

_SERVICE = "keel.reference.v1.ItemService"

# The per-method scopes the server factory's interceptor must enforce (ADR-0022):
# reads require ``items:read``, writes require ``items:write``. Pass this to
# ``create_server(required_scopes=...)`` so the servicer is never exposed without it.
ITEM_SERVICE_REQUIRED_SCOPES: dict[str, frozenset[str]] = {
    f"/{_SERVICE}/GetItem": frozenset({"items:read"}),
    f"/{_SERVICE}/ListItems": frozenset({"items:read"}),
    f"/{_SERVICE}/CreateItem": frozenset({"items:write"}),
}


class ItemServiceServicer(item_pb2_grpc.ItemServiceServicer):  # type: ignore[misc]  # base is untyped (vendored stub)
    """In-memory ItemService: reads require items:read, writes require items:write.

    Authentication and authorization are not re-implemented here; they are enforced
    by the server factory's interceptor. Each handler re-reads ``principal_var`` as a
    defense-in-depth check so the servicer still denies if it is ever registered
    without that interceptor.
    """

    def __init__(self) -> None:
        """Initialize an empty store with a monotonic id sequence."""
        self._items: dict[str, item_pb2.Item] = {}
        self._ids = itertools.count(1)
        # grpc.aio dispatches handlers on one event loop, but guard the store anyway so
        # it is safe if a servicer instance is shared with a thread-pool server too.
        self._lock = threading.Lock()

    async def _require_principal(self, context: grpc.aio.ServicerContext) -> Principal:
        """Return the authenticated caller from ``principal_var``, or abort UNAUTHENTICATED."""
        principal = principal_var.get()
        if principal is not None:
            return principal
        # Unreachable behind the server factory, which authenticates every call first.
        msg = "unauthenticated"  # pragma: no cover
        await context.abort(grpc.StatusCode.UNAUTHENTICATED, msg)  # pragma: no cover
        raise Unauthenticated(msg)  # pragma: no cover

    async def GetItem(  # noqa: N802  # mirrors the proto RPC name
        self, request: item_pb2.GetItemRequest, context: grpc.aio.ServicerContext
    ) -> item_pb2.GetItemResponse:
        """Fetch a single item by id. Requires scope items:read; NOT_FOUND if absent."""
        await self._require_principal(context)
        with self._lock:
            item = self._items.get(request.id)
        if item is None:
            await context.abort(grpc.StatusCode.NOT_FOUND, "item not found")
        return item_pb2.GetItemResponse(item=item)

    async def ListItems(  # noqa: N802  # mirrors the proto RPC name
        self, request: item_pb2.ListItemsRequest, context: grpc.aio.ServicerContext
    ) -> item_pb2.ListItemsResponse:
        """List a page of items. Requires scope items:read."""
        await self._require_principal(context)
        with self._lock:
            items = list(self._items.values())
        offset = max(request.offset, 0)
        page = items[offset:]
        if request.limit > 0:
            page = page[: request.limit]
        return item_pb2.ListItemsResponse(items=page)

    async def CreateItem(  # noqa: N802  # mirrors the proto RPC name
        self, request: item_pb2.CreateItemRequest, context: grpc.aio.ServicerContext
    ) -> item_pb2.CreateItemResponse:
        """Create a new item. Requires scope items:write; INVALID_ARGUMENT on empty name."""
        await self._require_principal(context)
        if not request.name:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "name is required")
        with self._lock:
            item = item_pb2.Item(id=f"item-{next(self._ids)}", name=request.name)
            self._items[item.id] = item
        return item_pb2.CreateItemResponse(item=item)
