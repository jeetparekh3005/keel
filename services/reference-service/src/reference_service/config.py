"""Typed configuration for the reference service (extends keel-core's base)."""

from __future__ import annotations

from pydantic import Field

from keel_core.config import BaseServiceConfig


class ReferenceConfig(BaseServiceConfig):
    """Reference-service settings; reads ``KEEL_``-prefixed environment variables."""

    service_name: str = "reference-service"
    database_url: str = "sqlite+aiosqlite://"
    oidc_issuer: str = ""
    oidc_audience: str = ""
    oidc_jwks_uri: str = ""
    otlp_endpoint: str = ""  # e.g. http://otel-collector:4317; empty = no span export
    otlp_insecure: bool = False  # secure by default; set true only for a plaintext collector
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_pool_timeout: int = 30
    db_pool_recycle: int = 1800
    # Default-deny CORS: explicit origins only (JSON list in KEEL_CORS_ALLOW_ORIGINS).
    cors_allow_origins: list[str] = Field(default_factory=list)
    trusted_hosts: list[str] = Field(default_factory=list)  # empty = accept any Host
    # Peers whose X-Forwarded-* headers are trusted (uvicorn ProxyHeadersMiddleware), so
    # scheme/host reflect the TLS-terminating edge and HSTS can fire. Fail-closed default:
    # trust only a co-located proxy. "*" trusts ANY peer and is spoofable on direct
    # exposure, so set KEEL_FORWARDED_ALLOW_IPS to the real proxy/mesh source explicitly
    # (the Helm chart sets it for the in-cluster topology).
    forwarded_allow_ips: str = "127.0.0.1"
    db_command_timeout: float = 30.0  # max seconds for a single statement (asyncpg)
    db_connect_timeout: float = 10.0  # max seconds to establish a connection (asyncpg)
    db_readiness_timeout: float = 5.0  # max seconds for the /readyz ping before 503
