"""Typed service configuration (platform.yaml config contract).

12-factor precedence (lowest to highest): built-in defaults, ``.env`` file,
environment variables. Secret-provider precedence is layered on top by the
SecretProvider adapter (ADR-0007). Invalid or missing config fails fast at
construction, before the service accepts traffic.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class BaseServiceConfig(BaseSettings):
    """Base typed configuration. Subclass per service to add fields.

    Reads ``KEEL_``-prefixed environment variables; unknown fields are rejected
    and instances are immutable.
    """

    model_config = SettingsConfigDict(
        env_prefix="KEEL_",
        env_file=".env",
        extra="forbid",
        frozen=True,
    )

    service_name: str
    version: str = "0.0.0"
    environment: str = "dev"
    log_level: str = "info"
