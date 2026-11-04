"""Typed configuration for the reference service (extends keel-core's base)."""

from __future__ import annotations

from keel_core.config import BaseServiceConfig


class ReferenceConfig(BaseServiceConfig):
    """Reference-service settings; reads ``KEEL_``-prefixed environment variables."""

    service_name: str = "reference-service"
    database_url: str = "sqlite+aiosqlite://"
    oidc_issuer: str = ""
    oidc_audience: str = ""
    oidc_jwks_uri: str = ""
    otlp_endpoint: str = ""  # e.g. http://otel-collector:4317; empty = no span export
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_pool_timeout: int = 30
    db_pool_recycle: int = 1800
    db_command_timeout: float = 30.0  # max seconds for a single statement (asyncpg)
    db_connect_timeout: float = 10.0  # max seconds to establish a connection (asyncpg)
    db_readiness_timeout: float = 5.0  # max seconds for the /readyz ping before 503
