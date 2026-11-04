"""Optional in-app request rate limiting (defense-in-depth).

The primary rate-limit control is the API gateway (APISIX; ADR-0005), which is
shared across replicas. This per-instance token-bucket middleware is opt-in and
exists for single-instance deployments and local defense-in-depth; it is keyed
by client address and holds state in memory, so it does not coordinate across
replicas. Over the limit it returns a 429 ``problem+json`` with ``Retry-After``.
"""

from __future__ import annotations

import json
import time

from starlette.types import ASGIApp, Receive, Scope, Send

from keel_core.adapters.inbound.http.problem import PROBLEM_CONTENT_TYPE


class RateLimitMiddleware:
    """Per-client token-bucket limiter: ``max_requests`` per ``window_seconds``."""

    def __init__(self, app: ASGIApp, *, max_requests: int, window_seconds: float) -> None:
        """Configure bucket capacity (``max_requests``) and refill over the window."""
        self._app = app
        self._capacity = float(max_requests)
        self._refill_per_sec = max_requests / window_seconds
        self._retry_after = max(1, round(window_seconds / max_requests))
        self._buckets: dict[str, tuple[float, float]] = {}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Consume a token for the client; reject with 429 when the bucket is empty."""
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        client = scope.get("client")
        key = client[0] if client else "unknown"
        now = time.monotonic()
        tokens, last = self._buckets.get(key, (self._capacity, now))
        tokens = min(self._capacity, tokens + (now - last) * self._refill_per_sec)
        if tokens < 1.0:
            self._buckets[key] = (tokens, now)
            await self._reject(scope, send)
            return
        self._buckets[key] = (tokens - 1.0, now)
        await self._app(scope, receive, send)

    async def _reject(self, scope: Scope, send: Send) -> None:
        body = json.dumps(
            {
                "type": "urn:keel:error:rate_limited",
                "title": "Too Many Requests",
                "status": 429,
                "instance": scope.get("path", ""),
                "detail": "Rate limit exceeded; retry later.",
            }
        ).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", PROBLEM_CONTENT_TYPE.encode()),
                    (b"retry-after", str(self._retry_after).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
