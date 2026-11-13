"""gRPC server (GrpcApi) adapter."""

from keel_core.adapters.inbound.rpc.item_service import (
    ITEM_SERVICE_REQUIRED_SCOPES,
    ItemServiceServicer,
)
from keel_core.adapters.inbound.rpc.server import AuthInterceptor, create_server

__all__ = [
    "ITEM_SERVICE_REQUIRED_SCOPES",
    "AuthInterceptor",
    "ItemServiceServicer",
    "create_server",
]
