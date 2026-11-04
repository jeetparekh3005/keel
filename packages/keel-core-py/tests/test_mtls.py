"""mTLS credential builders for gRPC (audit #25)."""

from datetime import UTC, datetime, timedelta

import grpc
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from keel_core.adapters.outbound.rpc import mtls_channel_credentials, mtls_server_credentials


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


def test_channel_credentials_are_grpc_channel_credentials() -> None:
    ca, cert, key = _pki()
    creds = mtls_channel_credentials(root_ca=ca, cert=cert, key=key)
    assert isinstance(creds, grpc.ChannelCredentials)


def test_server_credentials_are_grpc_server_credentials() -> None:
    ca, cert, key = _pki()
    creds = mtls_server_credentials(root_ca=ca, cert=cert, key=key)
    assert isinstance(creds, grpc.ServerCredentials)
