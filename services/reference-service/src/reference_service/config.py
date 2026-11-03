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
