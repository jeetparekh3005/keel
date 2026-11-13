"""mTLS credential builders and real loopback handshake (audit #25).

The builders are asserted to produce valid grpc credentials, and a real in-process
server is stood up with mTLS server credentials to prove the wiring end to end: a
client holding a cert signed by the trusted CA completes the handshake and makes an
authenticated call, while a client holding a cert from a DIFFERENT (untrusted) CA is
rejected at the TLS layer. All key material is generated at test time and never
committed.
"""

import ipaddress
from datetime import UTC, datetime, timedelta

import grpc
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from cryptography.x509.oid import NameOID

from keel_core.adapters.inbound.rpc import create_server
from keel_core.adapters.outbound.rpc import (
    create_channel,
    mtls_channel_credentials,
    mtls_server_credentials,
)
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator

_AUTH = (("authorization", "Bearer tok"),)
_METHOD = "/keel.Echo/Ping"


def _self_signed() -> tuple[bytes, bytes, bytes]:
    """Return (root_ca_pem, cert_pem, key_pem) for a single self-signed identity."""
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
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    return cert_pem, cert_pem, key_pem  # self-signed: the cert is its own CA


def _ca(common_name: str) -> tuple[x509.Certificate, RSAPrivateKey]:
    """Create a CA certificate and its key (basic-constraints CA:TRUE)."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
        .not_valid_after(datetime.now(UTC) + timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    return cert, key


def _leaf(
    ca_cert: x509.Certificate,
    ca_key: RSAPrivateKey,
    common_name: str,
    *,
    sans: list[x509.GeneralName] | None = None,
) -> tuple[bytes, bytes]:
    """Issue a CA-signed leaf cert for ``common_name``; return (cert_pem, key_pem)."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    builder = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
        .not_valid_after(datetime.now(UTC) + timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
    )
    if sans is not None:
        builder = builder.add_extension(x509.SubjectAlternativeName(sans), critical=False)
    cert = builder.sign(ca_key, hashes.SHA256())
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    return cert_pem, key_pem


async def _echo(request, context):
    return request


def _generic():
    handlers = {"Ping": grpc.unary_unary_rpc_method_handler(_echo)}
    return grpc.method_handlers_generic_handler("keel.Echo", handlers)


def test_channel_credentials_are_grpc_channel_credentials() -> None:
    ca, cert, key = _self_signed()
    creds = mtls_channel_credentials(root_ca=ca, cert=cert, key=key)
    assert isinstance(creds, grpc.ChannelCredentials)


def test_server_credentials_are_grpc_server_credentials() -> None:
    ca, cert, key = _self_signed()
    creds = mtls_server_credentials(root_ca=ca, cert=cert, key=key)
    assert isinstance(creds, grpc.ServerCredentials)


async def test_trusted_client_handshakes_and_untrusted_ca_client_is_rejected() -> None:
    # One trusted CA signs the server and a trusted client; a second, untrusted CA
    # signs a different client. The server trusts only the first CA's root.
    ca_cert, ca_key = _ca("keel-trusted-ca")
    ca_pem = ca_cert.public_bytes(serialization.Encoding.PEM)
    server_sans = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    server_cert, server_key = _leaf(ca_cert, ca_key, "localhost", sans=server_sans)
    client_cert, client_key = _leaf(ca_cert, ca_key, "keel-client")

    rogue_ca_cert, rogue_ca_key = _ca("keel-rogue-ca")
    rogue_cert, rogue_key = _leaf(rogue_ca_cert, rogue_ca_key, "keel-rogue-client")

    stub = StubAuthenticator({"tok": Principal(subject="svc-1", scopes=frozenset())})
    server, port = create_server(
        stub,
        required_scopes={_METHOD: frozenset()},  # explicit-open: auth only, no scope needed
        bind_address="127.0.0.1:0",
        server_credentials=mtls_server_credentials(
            root_ca=ca_pem, cert=server_cert, key=server_key
        ),
    )
    server.add_generic_rpc_handlers((_generic(),))
    await server.start()
    try:
        # Trusted client: cert signed by the CA the server trusts -> handshake + call OK.
        trusted = mtls_channel_credentials(root_ca=ca_pem, cert=client_cert, key=client_key)
        async with create_channel(f"localhost:{port}", credentials=trusted) as channel:
            assert await channel.unary_unary(_METHOD)(b"ping", metadata=_AUTH) == b"ping"

        # Untrusted client: trusts the server (root_ca=ca_pem) but presents a cert signed
        # by a CA the server does NOT trust -> server rejects it at the TLS layer.
        untrusted = mtls_channel_credentials(root_ca=ca_pem, cert=rogue_cert, key=rogue_key)
        async with create_channel(f"localhost:{port}", credentials=untrusted) as channel:
            with pytest.raises(grpc.aio.AioRpcError):
                await channel.unary_unary(_METHOD)(b"ping", metadata=_AUTH)
    finally:
        await server.stop(grace=None)
