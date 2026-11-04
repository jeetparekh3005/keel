"""mTLS credential builders for gRPC (ADR-0012; PKI from OpenBao, ADR-0007).

Build client and server credentials from PEM bytes (root CA + leaf cert + key).
Use ``mtls_channel_credentials`` with ``create_channel(credentials=...)`` on the
client, and ``mtls_server_credentials`` with ``server.add_secure_port(...)`` on
the server, so service-to-service calls are mutually authenticated.
"""

from __future__ import annotations

import grpc


def mtls_channel_credentials(
    *,
    root_ca: bytes,
    cert: bytes,
    key: bytes,
) -> grpc.ChannelCredentials:
    """Client-side mTLS: present ``cert``/``key`` and verify the server against ``root_ca``."""
    return grpc.ssl_channel_credentials(
        root_certificates=root_ca,
        private_key=key,
        certificate_chain=cert,
    )


def mtls_server_credentials(
    *,
    root_ca: bytes,
    cert: bytes,
    key: bytes,
    require_client_auth: bool = True,
) -> grpc.ServerCredentials:
    """Server-side mTLS: serve ``cert``/``key`` and require client certs signed by ``root_ca``."""
    return grpc.ssl_server_credentials(
        ((key, cert),),
        root_certificates=root_ca,
        require_client_auth=require_client_auth,
    )
