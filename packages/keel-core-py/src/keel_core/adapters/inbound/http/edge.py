"""Edge-hardening ASGI middleware: security headers and a request body-size limit."""

from __future__ import annotations

import json

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Always safe for a JSON API (no HTML/scripts of our own to allow).
_BASE_HEADERS: tuple[tuple[str, str], ...] = (
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    ("content-security-policy", "default-src 'none'; frame-ancestors 'none'"),
    ("permissions-policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()"),
)
_HSTS_VALUE = "max-age=31536000; includeSubDomains"

_DEFAULT_MAX_BYTES = 1_048_576  # 1 MiB


class _BodyTooLargeError(Exception):
    """Raised mid-stream when the accumulated request body exceeds the limit."""


class SecurityHeadersMiddleware:
    """Adds baseline security headers to every HTTP response."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap the downstream ASGI app."""
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Append the security headers on the response start message."""
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        # HSTS is only meaningful over TLS; emitting it on plaintext is misleading.
        is_https = scope.get("scheme") == "https"

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for key, value in _BASE_HEADERS:
                    headers.setdefault(key, value)
                if is_https:
                    headers.setdefault("strict-transport-security", _HSTS_VALUE)
            await send(message)

        await self._app(scope, receive, send_wrapper)


class BodyLimitMiddleware:
    """Rejects requests whose declared ``Content-Length`` exceeds ``max_bytes`` (413).

    Guards the common large-payload DoS vector before auth/handlers run. Streaming
    (chunked, no Content-Length) enforcement is delegated to the gateway/server.
    """

    def __init__(self, app: ASGIApp, *, max_bytes: int = _DEFAULT_MAX_BYTES) -> None:
        """Wrap the app with a maximum request body size."""
        self._app = app
        self._max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Reject over-limit requests with a problem+json 413 (header fast-path + streaming)."""
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        content_length = Headers(scope=scope).get("content-length")
        too_large = (
            content_length is not None
            and content_length.isdigit()
            and int(content_length) > self._max_bytes
        )
        if too_large:
            await self._reject(send)
            return

        # Also enforce on the body stream: chunked / lying Content-Length requests
        # are capped as bytes arrive, not trusted on the header alone.
        received = 0

        async def guarded_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self._max_bytes:
                    raise _BodyTooLargeError
            return message

        try:
            await self._app(scope, guarded_receive, send)
        except _BodyTooLargeError:
            await self._reject(send)

    async def _reject(self, send: Send) -> None:
        body = json.dumps(
            {
                "type": "urn:keel:error:payload_too_large",
                "title": "Payload Too Large",
                "status": 413,
            },
        ).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/problem+json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            },
        )
        await send({"type": "http.response.body", "body": body})
