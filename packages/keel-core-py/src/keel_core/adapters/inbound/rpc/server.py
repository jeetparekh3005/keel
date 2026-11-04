"""gRPC server factory: deny-by-default auth + OpenTelemetry interceptors (ADR-0012).

The server records a span per call and continues the inbound trace context, and
it authenticates every call by default: a request without a valid Bearer token
is rejected with ``UNAUTHENTICATED`` before it reaches a servicer. Because the
auth interceptor is installed by the factory and covers every method, there is
no way to register an unauthenticated servicer (deny-by-default by construction).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from typing import TYPE_CHECKING

import grpc
from opentelemetry.instrumentation.grpc import aio_server_interceptor

from keel_core.domain.errors import Unauthenticated

if TYPE_CHECKING:
    from keel_core.ports.auth import Authenticator

_BEARER_PREFIX = "bearer "


def _bearer_token(metadata: Iterable[tuple[str, str | bytes]] | None) -> str | None:
    """Return the Bearer token from call metadata, or None if absent/malformed."""
    for key, value in metadata or ():
        if key.lower() == "authorization":
            text = value.decode() if isinstance(value, bytes) else value
            if text.lower().startswith(_BEARER_PREFIX):
                return text[len(_BEARER_PREFIX) :].strip()
    return None


def _unauthenticated_handler(details: str) -> grpc.RpcMethodHandler:
    """A method handler that aborts every call with UNAUTHENTICATED."""

    async def abort(_request: object, context: grpc.aio.ServicerContext) -> None:
        await context.abort(grpc.StatusCode.UNAUTHENTICATED, details)

    return grpc.unary_unary_rpc_method_handler(abort)


class AuthInterceptor(grpc.aio.ServerInterceptor):  # type: ignore[misc]  # base is Any (stub-less)
    """Reject gRPC calls that lack a valid Bearer token (deny-by-default).

    Verification runs off the event loop (PyJWT is blocking). Methods whose full
    path is in ``exempt`` (e.g. health or reflection) bypass the check.
    """

    def __init__(
        self,
        authenticator: Authenticator,
        *,
        exempt: frozenset[str] = frozenset(),
    ) -> None:
        """Bind the authenticator and the set of exempt method paths."""
        self._authenticator = authenticator
        self._exempt = exempt

    async def intercept_service(
        self,
        continuation: Callable[[grpc.HandlerCallDetails], Awaitable[grpc.RpcMethodHandler]],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler:
        """Authenticate, then delegate to the real handler or abort."""
        if handler_call_details.method in self._exempt:
            return await continuation(handler_call_details)
        token = _bearer_token(handler_call_details.invocation_metadata)
        if token is None:
            return _unauthenticated_handler("missing or malformed bearer token")
        try:
            await asyncio.to_thread(self._authenticator.authenticate, token)
        except Unauthenticated:
            return _unauthenticated_handler("invalid token")
        return await continuation(handler_call_details)


def create_server(
    authenticator: Authenticator,
    *,
    exempt_methods: frozenset[str] = frozenset(),
) -> grpc.aio.Server:
    """Create an async gRPC server with deny-by-default auth and tracing.

    ``authenticator`` is required: the auth interceptor it powers covers every
    registered method, so a servicer cannot be exposed unauthenticated. Pass
    ``exempt_methods`` (full paths like ``/grpc.health.v1.Health/Check``) for
    intentional exceptions. Register servicers on the returned server, then start.
    """
    return grpc.aio.server(
        interceptors=[
            AuthInterceptor(authenticator, exempt=exempt_methods),
            aio_server_interceptor(),  # type: ignore[no-untyped-call]  # upstream untyped
        ],
    )
