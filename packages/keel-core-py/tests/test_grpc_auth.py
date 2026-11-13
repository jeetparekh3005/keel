"""gRPC deny-by-default auth, scope authorization, and streaming (audit #64, #121).

Real in-process server+client so unary and streaming cardinalities are exercised.
"""

import grpc
import pytest

from keel_core.adapters.inbound.rpc import create_server
from keel_core.adapters.outbound.rpc import create_channel
from keel_core.context import principal_var
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator

_AUTH = (("authorization", "Bearer tok"),)


async def _echo(request, context):
    return request


async def _echo_stream(request, context):
    yield request
    yield request


async def _whoami(request, context):
    principal = principal_var.get()
    return (principal.subject if principal else "none").encode()


def _generic():
    handlers = {
        "Ping": grpc.unary_unary_rpc_method_handler(_echo),
        "WhoAmI": grpc.unary_unary_rpc_method_handler(_whoami),
        "PingStream": grpc.unary_stream_rpc_method_handler(_echo_stream),
    }
    return grpc.method_handlers_generic_handler("keel.Echo", handlers)


# Echo's methods are explicitly open (empty scope set): any authenticated caller may
# call them. Under deny-by-default an UNmapped method is closed, so methods a test
# expects to succeed with only authentication must be listed here.
_OPEN_SCOPES = {
    "/keel.Echo/Ping": frozenset(),
    "/keel.Echo/WhoAmI": frozenset(),
    "/keel.Echo/PingStream": frozenset(),
}


async def _serve(*, required_scopes=None, **kwargs):
    stub = StubAuthenticator({"tok": Principal(subject="svc-1", scopes=frozenset({"read"}))})
    scopes = _OPEN_SCOPES if required_scopes is None else required_scopes
    server = create_server(stub, required_scopes=scopes, **kwargs)
    server.add_generic_rpc_handlers((_generic(),))
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    return server, port


async def test_unary_without_token_is_unauthenticated():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            with pytest.raises(grpc.aio.AioRpcError) as exc:
                await channel.unary_unary("/keel.Echo/Ping")(b"x")
            assert exc.value.code() == grpc.StatusCode.UNAUTHENTICATED
    finally:
        await server.stop(grace=None)


async def test_unary_with_valid_token_succeeds_and_propagates_principal():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            assert await channel.unary_unary("/keel.Echo/Ping")(b"x", metadata=_AUTH) == b"x"
            # The servicer sees the authenticated principal via the contextvar.
            assert await channel.unary_unary("/keel.Echo/WhoAmI")(b"", metadata=_AUTH) == b"svc-1"
    finally:
        await server.stop(grace=None)


async def test_insufficient_scope_is_permission_denied():
    server, port = await _serve(required_scopes={"/keel.Echo/Ping": {"admin"}})
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            with pytest.raises(grpc.aio.AioRpcError) as exc:
                await channel.unary_unary("/keel.Echo/Ping")(b"x", metadata=_AUTH)
            assert exc.value.code() == grpc.StatusCode.PERMISSION_DENIED
    finally:
        await server.stop(grace=None)


async def test_authenticated_call_to_unmapped_method_is_permission_denied():
    # Deny-by-default: a method absent from the scope map is closed even to an
    # authenticated caller, while an explicit empty-set entry stays open. Here WhoAmI
    # is mapped open and Ping is absent, so the same authenticated caller is allowed on
    # WhoAmI but denied on Ping. This fails on a fail-open .get(method, frozenset()).
    server, port = await _serve(required_scopes={"/keel.Echo/WhoAmI": frozenset()})
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            with pytest.raises(grpc.aio.AioRpcError) as exc:
                await channel.unary_unary("/keel.Echo/Ping")(b"x", metadata=_AUTH)
            assert exc.value.code() == grpc.StatusCode.PERMISSION_DENIED
            # The explicitly-open method still succeeds (absent != present-but-empty).
            assert await channel.unary_unary("/keel.Echo/WhoAmI")(b"", metadata=_AUTH) == b"svc-1"
    finally:
        await server.stop(grace=None)


async def test_streaming_without_token_is_clean_unauthenticated():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            with pytest.raises(grpc.aio.AioRpcError) as exc:
                async for _ in channel.unary_stream("/keel.Echo/PingStream")(b"x"):
                    pass
            assert exc.value.code() == grpc.StatusCode.UNAUTHENTICATED
    finally:
        await server.stop(grace=None)


async def test_streaming_with_valid_token_succeeds():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            got = [
                r async for r in channel.unary_stream("/keel.Echo/PingStream")(b"x", metadata=_AUTH)
            ]
            assert got == [b"x", b"x"]
    finally:
        await server.stop(grace=None)


async def test_exempt_method_bypasses_auth():
    server, port = await _serve(exempt_methods=frozenset({"/keel.Echo/Ping"}))
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            assert await channel.unary_unary("/keel.Echo/Ping")(b"x") == b"x"
    finally:
        await server.stop(grace=None)
