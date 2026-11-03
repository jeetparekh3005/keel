"""HTTP RED-metrics middleware (request count + latency), via OpenTelemetry."""

from __future__ import annotations

import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from keel_core.adapters.outbound.telemetry import get_meter


class MetricsMiddleware:
    """Records request count and duration per method/route/status (no-op if unconfigured)."""

    def __init__(self, app: ASGIApp, *, meter_name: str = "keel.http") -> None:
        """Create request/duration instruments from the global meter."""
        self._app = app
        meter = get_meter(meter_name)
        self._requests = meter.create_counter(
            "http.server.requests", unit="1", description="HTTP requests handled"
        )
        self._duration = meter.create_histogram(
            "http.server.duration", unit="ms", description="HTTP request duration"
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Time the request and record the instruments on completion."""
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
            attributes: dict[str, str | int] = {
                "http.method": str(scope.get("method", "")),
                "http.route": str(scope.get("path", "")),
                "http.status_code": status,
            }
            self._requests.add(1, attributes)
            self._duration.record((time.perf_counter() - start) * 1000, attributes)
