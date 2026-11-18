"""Secret provider adapters: EnvSecretProvider (dev); OpenBao + AWS + GCP (prod).

ADR-0023 ships the OpenBao/Vault backend; ADR-0024 adds AWS Secrets Manager and GCP Secret
Manager over a shared caching core (``CachingSecretProvider``). ``secret_provider_from_env``
selects among them.
"""

from keel_core.adapters.outbound.secrets.aws import AwsSecretsManagerSecretProvider
from keel_core.adapters.outbound.secrets.caching import CachingSecretProvider
from keel_core.adapters.outbound.secrets.env import EnvSecretProvider
from keel_core.adapters.outbound.secrets.factory import secret_provider_from_env
from keel_core.adapters.outbound.secrets.gcp import GcpSecretManagerSecretProvider
from keel_core.adapters.outbound.secrets.openbao import OpenBaoSecretProvider

__all__ = [
    "AwsSecretsManagerSecretProvider",
    "CachingSecretProvider",
    "EnvSecretProvider",
    "GcpSecretManagerSecretProvider",
    "OpenBaoSecretProvider",
    "secret_provider_from_env",
]
