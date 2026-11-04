"""HTTP server metrics middleware, following OpenTelemetry semantic conventions.

Emits ``http.server.request.duration`` (a histogram, in seconds) with the stable
semconv attributes. The histogram's own count is the request volume, so no
separate request counter is needed.
"""

from __future__ import annotations

import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from keel_core.adapters.outbound.telemetry import get_meter


class MetricsMiddleware:
    """Records request duration per method/route/status (no-op if unconfigured)."""

    def __init__(self, app: ASGIApp, *, meter_name: str = "keel.http") -> None:
        """Create the duration histogram from the global meter."""
        self._app = app
        meter = get_meter(meter_name)
        self._duration = meter.create_histogram(
            "http.server.request.duration",
            unit="s",
            description="Duration of inbound HTTP server requests.",
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Time the request and record the histogram on completion."""
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        start = time.perf_counter()
        status = 500

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
            await send(message)

        try:
            await self._app(scope, receive, send_wrapper)
        finally:
            # Use the matched route TEMPLATE (/items/{id}), never the raw path, to
            # avoid unbounded metric cardinality. Unmatched requests share one bucket.
            route = scope.get("route")
            http_route = getattr(route, "path_format", None) or "__unmatched__"
            attributes: dict[str, str | int] = {
                "http.request.method": str(scope.get("method", "")),
                "http.response.status_code": status,
                "http.route": http_route,
            }
            # Semconv duration is measured in seconds.
            self._duration.record(time.perf_counter() - start, attributes)
