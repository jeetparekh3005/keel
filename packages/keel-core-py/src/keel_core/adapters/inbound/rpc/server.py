"""gRPC server factory with the OpenTelemetry server interceptor (ADR-0012).

The server records a span per call and continues the inbound trace context, so
east-west gRPC calls join the same trace as the originating request.
"""

from __future__ import annotations

import grpc
from opentelemetry.instrumentation.grpc import aio_server_interceptor


def create_server() -> grpc.aio.Server:
    """Create an async gRPC server that traces each call. Register servicers, then start."""
    return grpc.aio.server(
        interceptors=[aio_server_interceptor()],  # type: ignore[no-untyped-call]  # upstream untyped
    )
