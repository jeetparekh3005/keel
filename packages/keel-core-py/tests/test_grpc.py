import grpc

from keel_core.adapters.inbound.rpc import create_server
from keel_core.adapters.outbound.rpc import create_channel
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator

_AUTH = (("authorization", "Bearer tok"),)


async def _echo(request, context):
    return request


async def test_roundtrip_over_instrumented_channel():
    handler = grpc.unary_unary_rpc_method_handler(_echo)
    generic = grpc.method_handlers_generic_handler("keel.Echo", {"Ping": handler})
    server = create_server(StubAuthenticator({"tok": Principal(subject="svc")}))
    server.add_generic_rpc_handlers((generic,))
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            response = await channel.unary_unary("/keel.Echo/Ping")(b"ping", metadata=_AUTH)
            assert response == b"ping"
    finally:
        await server.stop(grace=None)
