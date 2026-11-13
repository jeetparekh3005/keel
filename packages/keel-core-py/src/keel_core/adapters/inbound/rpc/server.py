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
import contextlib
from collections.abc import Awaitable, Callable, Iterable, Mapping
from typing import TYPE_CHECKING, Any, overload

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
    authenticator: Authenticator, required: frozenset[str] | None
) -> Callable[[Any], Awaitable[Principal]]:
    """Build an async check: authenticate the call, enforce scopes, return the Principal.

    ``required`` is the method's scope policy: a frozenset (possibly empty) when the
    method is in the scope map, or ``None`` when it is absent. Absence is closed
    (deny-by-default): an authenticated caller is still rejected. An explicit empty
    set is the only way to say "any authenticated caller may call this".
    """

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
        if required is None:
            # Deny-by-default: a method absent from the scope map is closed, even to an
            # authenticated caller. Using .get(method) (None when absent) rather than
            # .get(method, frozenset()) is what makes absence fail closed instead of
            # fail open (an empty required set is a subset of every scope set).
            await context.abort(grpc.StatusCode.PERMISSION_DENIED, "method is not authorized")
        if not required.issubset(principal.scopes):  # type: ignore[union-attr]  # abort() raised above if None
            await context.abort(grpc.StatusCode.PERMISSION_DENIED, "insufficient scope")
        return principal

    return check


def _wrap_handler(
    handler: Any,  # noqa: ANN401  # grpc RpcMethodHandler is stub-less
    authenticator: Authenticator,
    required: frozenset[str] | None,
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
                # An async generator can close in a different context than the set,
                # making reset(token) raise ValueError. Each RPC runs in its own
                # task, so suppressing the cross-context reset cannot leak across RPCs.
                with contextlib.suppress(ValueError):
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
            # See unary_stream: guard the cross-context reset on generator close.
            with contextlib.suppress(ValueError):
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
        # .get returns None when the method is absent from the scope map; that None is
        # deny-by-default (closed). A present entry (even an empty frozenset) is honored
        # as-is, so an explicit empty set stays "any authenticated caller".
        required = self._required_scopes.get(handler_call_details.method)
        return _wrap_handler(handler, self._authenticator, required)


@overload
def create_server(
    authenticator: Authenticator,
    *,
    exempt_methods: frozenset[str] = ...,
    required_scopes: Mapping[str, Iterable[str]] | None = ...,
    bind_address: None = ...,
    server_credentials: grpc.ServerCredentials | None = ...,
) -> grpc.aio.Server: ...


@overload
def create_server(
    authenticator: Authenticator,
    *,
    exempt_methods: frozenset[str] = ...,
    required_scopes: Mapping[str, Iterable[str]] | None = ...,
    bind_address: str,
    server_credentials: grpc.ServerCredentials | None = ...,
) -> tuple[grpc.aio.Server, int]: ...


def create_server(
    authenticator: Authenticator,
    *,
    exempt_methods: frozenset[str] = frozenset(),
    required_scopes: Mapping[str, Iterable[str]] | None = None,
    bind_address: str | None = None,
    server_credentials: grpc.ServerCredentials | None = None,
) -> grpc.aio.Server | tuple[grpc.aio.Server, int]:
    """Create an async gRPC server with deny-by-default auth, authZ, and tracing.

    ``authenticator`` is required: the interceptor covers every registered method,
    so a servicer cannot be exposed unauthenticated. ``exempt_methods`` bypass auth
    (health/reflection); ``required_scopes`` maps a full method path to the scopes
    a caller must hold (else PERMISSION_DENIED).

    Transport credentials are wired here so mTLS is not left to the caller. When
    ``bind_address`` is given the server binds it and returns ``(server, port)``:
    with ``server_credentials`` (build them with ``mtls_server_credentials``) the
    port is secured via ``add_secure_port`` and mutual TLS is enforced; without
    them it falls back to ``add_insecure_port`` for the no-TLS/dev path. When
    ``bind_address`` is omitted the unbound server is returned so the caller can
    bind its own port (backward-compatible).
    """
    server = grpc.aio.server(
        interceptors=[
            AuthInterceptor(authenticator, exempt=exempt_methods, required_scopes=required_scopes),
            aio_server_interceptor(),  # type: ignore[no-untyped-call]  # upstream untyped
        ],
    )
    if bind_address is None:
        return server
    if server_credentials is None:
        port = server.add_insecure_port(bind_address)
    else:
        port = server.add_secure_port(bind_address, server_credentials)
    return server, port
