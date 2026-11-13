"""Concrete gRPC ItemService: deny-by-default auth, per-method scopes, mTLS (ADR-0022).

A real in-process server (the keel-core factory + the generated ItemService stubs)
exercises the three auth outcomes end to end: no token -> UNAUTHENTICATED, a valid
token lacking the method scope -> PERMISSION_DENIED, a valid token with the scope ->
OK with the expected payload. The mTLS credential builders are asserted to still
produce valid server/client credentials (mirrors test_mtls.py).
"""

from datetime import UTC, datetime, timedelta

import grpc
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

import keel_core.genproto  # noqa: F401  # side effect: puts the vendored stubs on sys.path
from keel.reference.v1 import item_pb2, item_pb2_grpc
from keel_core.adapters.inbound.rpc import (
    ITEM_SERVICE_REQUIRED_SCOPES,
    ItemServiceServicer,
    create_server,
)
from keel_core.adapters.outbound.rpc import (
    create_channel,
    mtls_channel_credentials,
    mtls_server_credentials,
)
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator

# Three valid tokens with different scope grants plus one unknown token (no principal).
_PRINCIPALS = {
    "read-tok": Principal(subject="reader", scopes=frozenset({"items:read"})),
    "write-tok": Principal(subject="writer", scopes=frozenset({"items:read", "items:write"})),
    "noscope-tok": Principal(subject="nobody", scopes=frozenset()),
}


def _auth(token: str) -> tuple[tuple[str, str], ...]:
    return (("authorization", f"Bearer {token}"),)


async def _serve() -> tuple[grpc.aio.Server, int]:
    """Start an in-process ItemService behind the deny-by-default factory."""
    server = create_server(
        StubAuthenticator(_PRINCIPALS),
        required_scopes=ITEM_SERVICE_REQUIRED_SCOPES,
    )
    item_pb2_grpc.add_ItemServiceServicer_to_server(ItemServiceServicer(), server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    return server, port


async def test_call_without_token_is_unauthenticated():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            stub = item_pb2_grpc.ItemServiceStub(channel)
            with pytest.raises(grpc.aio.AioRpcError) as exc:
                await stub.GetItem(item_pb2.GetItemRequest(id="item-1"))
            assert exc.value.code() == grpc.StatusCode.UNAUTHENTICATED
    finally:
        await server.stop(grace=None)


async def test_valid_token_without_scope_is_permission_denied():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            stub = item_pb2_grpc.ItemServiceStub(channel)
            # noscope-tok authenticates but holds neither items:read nor items:write.
            with pytest.raises(grpc.aio.AioRpcError) as read_exc:
                await stub.GetItem(
                    item_pb2.GetItemRequest(id="item-1"), metadata=_auth("noscope-tok")
                )
            assert read_exc.value.code() == grpc.StatusCode.PERMISSION_DENIED
            # A read-only token may read but must not write (per-method scope).
            with pytest.raises(grpc.aio.AioRpcError) as write_exc:
                await stub.CreateItem(
                    item_pb2.CreateItemRequest(name="widget"), metadata=_auth("read-tok")
                )
            assert write_exc.value.code() == grpc.StatusCode.PERMISSION_DENIED
    finally:
        await server.stop(grace=None)


async def test_valid_token_with_scope_succeeds_with_expected_payload():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            stub = item_pb2_grpc.ItemServiceStub(channel)
            created = await stub.CreateItem(
                item_pb2.CreateItemRequest(name="widget"), metadata=_auth("write-tok")
            )
            assert created.item.id == "item-1"
            assert created.item.name == "widget"
            # Read it back with a read-scoped token: GetItem and ListItems both return it.
            got = await stub.GetItem(
                item_pb2.GetItemRequest(id="item-1"), metadata=_auth("read-tok")
            )
            assert got.item.name == "widget"
            listed = await stub.ListItems(item_pb2.ListItemsRequest(), metadata=_auth("read-tok"))
            assert [i.name for i in listed.items] == ["widget"]
    finally:
        await server.stop(grace=None)


async def test_get_missing_item_is_not_found():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            stub = item_pb2_grpc.ItemServiceStub(channel)
            with pytest.raises(grpc.aio.AioRpcError) as exc:
                await stub.GetItem(
                    item_pb2.GetItemRequest(id="missing"), metadata=_auth("read-tok")
                )
            assert exc.value.code() == grpc.StatusCode.NOT_FOUND
    finally:
        await server.stop(grace=None)


async def test_create_with_empty_name_is_invalid_argument():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            stub = item_pb2_grpc.ItemServiceStub(channel)
            with pytest.raises(grpc.aio.AioRpcError) as exc:
                await stub.CreateItem(
                    item_pb2.CreateItemRequest(name=""), metadata=_auth("write-tok")
                )
            assert exc.value.code() == grpc.StatusCode.INVALID_ARGUMENT
    finally:
        await server.stop(grace=None)


async def test_list_items_honors_limit_and_offset():
    server, port = await _serve()
    try:
        async with create_channel(f"127.0.0.1:{port}") as channel:
            stub = item_pb2_grpc.ItemServiceStub(channel)
            for name in ("a", "b", "c"):
                await stub.CreateItem(
                    item_pb2.CreateItemRequest(name=name), metadata=_auth("write-tok")
                )
            page = await stub.ListItems(
                item_pb2.ListItemsRequest(limit=1, offset=1), metadata=_auth("read-tok")
            )
            assert [i.name for i in page.items] == ["b"]
    finally:
        await server.stop(grace=None)


def _pki() -> tuple[bytes, bytes, bytes]:
    """Return (root_ca_pem, cert_pem, key_pem) for a self-signed test identity."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "keel-test")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
        .not_valid_after(datetime.now(UTC) + timedelta(hours=1))
        .sign(key, hashes.SHA256())
    )
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    return cert_pem, cert_pem, key_pem  # self-signed: the cert is its own CA


def test_mtls_builders_produce_valid_server_and_client_credentials():
    ca, cert, key = _pki()
    client = mtls_channel_credentials(root_ca=ca, cert=cert, key=key)
    server = mtls_server_credentials(root_ca=ca, cert=cert, key=key)
    assert isinstance(client, grpc.ChannelCredentials)
    assert isinstance(server, grpc.ServerCredentials)
