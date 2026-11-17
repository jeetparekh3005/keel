"""Secret provider adapters: EnvSecretProvider (dev); OpenBao + AWS Secrets Manager (prod).

ADR-0023 ships the OpenBao/Vault backend; ADR-0024 adds AWS Secrets Manager over a shared
caching core (``CachingSecretProvider``). ``secret_provider_from_env`` selects among them.
"""

from keel_core.adapters.outbound.secrets.aws import AwsSecretsManagerSecretProvider
from keel_core.adapters.outbound.secrets.caching import CachingSecretProvider
from keel_core.adapters.outbound.secrets.env import EnvSecretProvider
from keel_core.adapters.outbound.secrets.factory import secret_provider_from_env
from keel_core.adapters.outbound.secrets.openbao import OpenBaoSecretProvider

__all__ = [
    "AwsSecretsManagerSecretProvider",
    "CachingSecretProvider",
    "EnvSecretProvider",
    "OpenBaoSecretProvider",
    "secret_provider_from_env",
]
