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
from collections import OrderedDict

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from keel_core.adapters.inbound.http.problem import PROBLEM_CONTENT_TYPE

# Cap on distinct clients tracked at once; evicted LRU so the map cannot grow
# without bound (a spoofed-source flood would otherwise exhaust memory).
_DEFAULT_MAX_CLIENTS = 100_000


class RateLimitMiddleware:
    """Per-client token-bucket limiter: ``max_requests`` per ``window_seconds``.

    Keyed by the real client IP. Behind a trusted proxy/gateway (the documented
    topology) that is the first ``X-Forwarded-For`` hop; set ``trust_forwarded``
    to ``False`` for direct exposure so a client cannot spoof the header. State
    is an LRU bounded at ``max_clients`` entries.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        max_requests: int,
        window_seconds: float,
        trust_forwarded: bool = True,
        max_clients: int = _DEFAULT_MAX_CLIENTS,
    ) -> None:
        """Configure bucket capacity/refill, the forwarded-header trust, and the LRU cap."""
        self._app = app
        self._capacity = float(max_requests)
        self._refill_per_sec = max_requests / window_seconds
        self._retry_after = max(1, round(window_seconds / max_requests))
        self._trust_forwarded = trust_forwarded
        self._max_clients = max_clients
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()

    def _client_key(self, scope: Scope) -> str:
        if self._trust_forwarded:
            xff = Headers(scope=scope).get("x-forwarded-for")
            if xff:
                # Rightmost hop = the peer the trusted proxy actually observed. The
                # leftmost entries are client-supplied and spoofable, so keying on
                # them lets a client mint a fresh bucket (bypass) or drain a victim's
                # bucket per request. Assumes a single trusted proxy appends the peer.
                return xff.split(",")[-1].strip()
        client = scope.get("client")
        return client[0] if client else "unknown"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Consume a token for the client; reject with 429 when the bucket is empty."""
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        key = self._client_key(scope)
        now = time.monotonic()
        tokens, last = self._buckets.get(key, (self._capacity, now))
        tokens = min(self._capacity, tokens + (now - last) * self._refill_per_sec)
        allowed = tokens >= 1.0
        self._buckets[key] = (tokens - 1.0 if allowed else tokens, now)
        self._buckets.move_to_end(key)
        if len(self._buckets) > self._max_clients:
            self._buckets.popitem(last=False)  # evict least-recently-seen
        if not allowed:
            await self._reject(scope, send)
            return
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
