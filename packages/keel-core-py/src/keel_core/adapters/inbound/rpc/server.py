"""gRPC server factory: deny-by-default auth + authZ + OpenTelemetry (ADR-0012).

Every call is authenticated (valid Bearer token) and, if the method declares
required scopes, authorized. The authenticated ``Principal`` is published on
``keel_core.context.principal_var`` for the servicer. The interceptor wraps the
real handler preserving its cardinality, so unary and streaming methods are all
covered; rejections use the correct status (UNAUTHENTICATED / PERMISSION_DENIED).
Because the factory installs the interceptor, a servicer cannot be exposed
unauthenticated (deny-by-default by construction).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable, Mapping
from typing import TYPE_CHECKING, Any

import grpc
from opentelemetry.instrumentation.grpc import aio_server_interceptor

from keel_core.context import principal_var
from keel_core.domain.errors import Unauthenticated, Unavailable

if TYPE_CHECKING:
    from keel_core.ports.auth import Authenticator, Principal

_BEARER_PREFIX = "bearer "


def _bearer_token(metadata: Iterable[tuple[str, str | bytes]] | None) -> str | None:
    """Return the Bearer token from call metadata, or None if absent/malformed."""
    for key, value in metadata or ():
        if key.lower() == "authorization":
            text = value.decode() if isinstance(value, bytes) else value
            if text.lower().startswith(_BEARER_PREFIX):
                return text[len(_BEARER_PREFIX) :].strip()
    return None


def _authorize(
    authenticator: Authenticator, required: frozenset[str]
) -> Callable[[Any], Awaitable[Principal]]:
    """Build an async check: authenticate the call, enforce scopes, return the Principal."""

    async def check(context: Any) -> Principal:  # noqa: ANN401  # grpc context is stub-less
        token = _bearer_token(context.invocation_metadata())
        if token is None:
            # abort() raises, so execution never continues past here with token=None;
            # grpc's context is stub-less, so mypy cannot infer NoReturn.
            await context.abort(
                grpc.StatusCode.UNAUTHENTICATED, "missing or malformed bearer token"
            )
        try:
            principal: Principal = await asyncio.to_thread(authenticator.authenticate, token)  # type: ignore[arg-type]
        except Unauthenticated:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "invalid token")
        except Unavailable:
            # A signing-key/dependency outage is retryable, not an auth failure.
            await context.abort(grpc.StatusCode.UNAVAILABLE, "auth dependency unavailable")
        if not required.issubset(principal.scopes):
            await context.abort(grpc.StatusCode.PERMISSION_DENIED, "insufficient scope")
        return principal

    return check


def _wrap_handler(
    handler: Any,  # noqa: ANN401  # grpc RpcMethodHandler is stub-less
    authenticator: Authenticator,
    required: frozenset[str],
) -> Any:  # noqa: ANN401
    """Return a handler of the same cardinality that authenticates/authorizes first."""
    check = _authorize(authenticator, required)
    common = {
        "request_deserializer": handler.request_deserializer,
        "response_serializer": handler.response_serializer,
    }

    if handler.unary_unary is not None:
        inner = handler.unary_unary

        async def unary_unary(request: Any, context: Any) -> Any:  # noqa: ANN401
            principal = await check(context)
            token = principal_var.set(principal)
            try:
                return await inner(request, context)
            finally:
                principal_var.reset(token)

        return grpc.unary_unary_rpc_method_handler(unary_unary, **common)

    if handler.unary_stream is not None:
        inner = handler.unary_stream

        async def unary_stream(request: Any, context: Any) -> Any:  # noqa: ANN401
            principal = await check(context)
            token = principal_var.set(principal)
            try:
                async for response in inner(request, context):
                    yield response
            finally:
                principal_var.reset(token)

        return grpc.unary_stream_rpc_method_handler(unary_stream, **common)

    if handler.stream_unary is not None:
        inner = handler.stream_unary

        async def stream_unary(request_iterator: Any, context: Any) -> Any:  # noqa: ANN401
            principal = await check(context)
            token = principal_var.set(principal)
            try:
                return await inner(request_iterator, context)
            finally:
                principal_var.reset(token)

        return grpc.stream_unary_rpc_method_handler(stream_unary, **common)

    inner = handler.stream_stream

    async def stream_stream(request_iterator: Any, context: Any) -> Any:  # noqa: ANN401
        principal = await check(context)
        token = principal_var.set(principal)
        try:
            async for response in inner(request_iterator, context):
                yield response
        finally:
            principal_var.reset(token)

    return grpc.stream_stream_rpc_method_handler(stream_stream, **common)


class AuthInterceptor(grpc.aio.ServerInterceptor):  # type: ignore[misc]  # base is Any (stub-less)
    """Deny-by-default auth + optional per-method scope authorization for gRPC."""

    def __init__(
        self,
        authenticator: Authenticator,
        *,
        exempt: frozenset[str] = frozenset(),
        required_scopes: Mapping[str, Iterable[str]] | None = None,
    ) -> None:
        """Bind the authenticator, exempt method paths, and per-method required scopes."""
        self._authenticator = authenticator
        self._exempt = exempt
        self._required_scopes = {
            method: frozenset(scopes) for method, scopes in (required_scopes or {}).items()
        }

    async def intercept_service(
        self,
        continuation: Callable[[Any], Awaitable[Any]],
        handler_call_details: Any,  # noqa: ANN401
    ) -> Any:  # noqa: ANN401
        """Wrap the resolved handler with auth/authZ, preserving its cardinality."""
        handler = await continuation(handler_call_details)
        if handler is None or handler_call_details.method in self._exempt:
            return handler
        required = self._required_scopes.get(handler_call_details.method, frozenset())
        return _wrap_handler(handler, self._authenticator, required)


def create_server(
    authenticator: Authenticator,
    *,
    exempt_methods: frozenset[str] = frozenset(),
    required_scopes: Mapping[str, Iterable[str]] | None = None,
) -> grpc.aio.Server:
    """Create an async gRPC server with deny-by-default auth, authZ, and tracing.

    ``authenticator`` is required: the interceptor covers every registered method,
    so a servicer cannot be exposed unauthenticated. ``exempt_methods`` bypass auth
    (health/reflection); ``required_scopes`` maps a full method path to the scopes
    a caller must hold (else PERMISSION_DENIED).
    """
    return grpc.aio.server(
        interceptors=[
            AuthInterceptor(authenticator, exempt=exempt_methods, required_scopes=required_scopes),
            aio_server_interceptor(),  # type: ignore[no-untyped-call]  # upstream untyped
        ],
    )
