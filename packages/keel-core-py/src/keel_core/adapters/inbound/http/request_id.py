"""Request-id middleware (pure ASGI, so the contextvar reaches the endpoint and its logs)."""

from __future__ import annotations

import re
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from keel_core import context

_HEADER = "x-request-id"
# A client-supplied id is only propagated if it is a bounded, safe token; anything
# else is replaced with a fresh id so an attacker cannot reflect arbitrary content
# into the response header or log field.
_VALID_REQUEST_ID = re.compile(r"\A[A-Za-z0-9._-]{1,128}\Z")


class RequestIdMiddleware:
    """Mint or propagate ``x-request-id``, expose it on logs (via context) and the response."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap the downstream ASGI app."""
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Set the request id for the scope's lifetime and echo it on the response."""
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        incoming = Headers(scope=scope).get(_HEADER)
        request_id = (
            incoming if incoming and _VALID_REQUEST_ID.match(incoming) else uuid.uuid4().hex
        )
        token = context.request_id_var.set(request_id)

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)[_HEADER] = request_id
            await send(message)

        try:
            await self._app(scope, receive, send_wrapper)
        finally:
            context.request_id_var.reset(token)
