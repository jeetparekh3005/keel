"""gRPC server (GrpcApi) adapter."""

from keel_core.adapters.inbound.rpc.server import AuthInterceptor, create_server

__all__ = ["AuthInterceptor", "create_server"]
