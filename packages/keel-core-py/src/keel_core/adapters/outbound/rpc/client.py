"""gRPC ServiceClient channel factory with OpenTelemetry propagation (ADR-0012).

The channel carries OTel client interceptors, so outbound calls propagate the
active trace (W3C tracecontext) to the callee. mTLS credentials (from OpenBao
PKI) can be supplied for service-to-service auth.
"""

from __future__ import annotations

import grpc
from opentelemetry.instrumentation.grpc import aio_client_interceptors


def create_channel(
    target: str,
    *,
    credentials: grpc.ChannelCredentials | None = None,
) -> grpc.aio.Channel:
    """Create a trace-propagating async gRPC channel to ``target``.

    With ``credentials`` the channel uses mTLS; otherwise it is insecure (dev/in-cluster).
    """
    interceptors = aio_client_interceptors()  # type: ignore[no-untyped-call]  # upstream untyped
    if credentials is None:
        return grpc.aio.insecure_channel(target, interceptors=interceptors)
    return grpc.aio.secure_channel(target, credentials, interceptors=interceptors)
