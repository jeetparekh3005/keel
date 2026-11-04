"""gRPC client (ServiceClient) adapter."""

from keel_core.adapters.outbound.rpc.client import create_channel
from keel_core.adapters.outbound.rpc.tls import (
    mtls_channel_credentials,
    mtls_server_credentials,
)

__all__ = ["create_channel", "mtls_channel_credentials", "mtls_server_credentials"]
