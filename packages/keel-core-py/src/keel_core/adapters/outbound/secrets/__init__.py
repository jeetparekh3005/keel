"""Secret provider adapters. OpenBao (prod) arrives with the deployment slice."""

from keel_core.adapters.outbound.secrets.env import EnvSecretProvider

__all__ = ["EnvSecretProvider"]
