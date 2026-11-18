"""SecretProvider selection from the environment (ADR-0023, ADR-0024).

At most one of ``KEEL_VAULT_ADDR`` / ``KEEL_AWS_SECRET_ID`` / ``KEEL_GCP_SECRET`` may be
set (each non-empty after trimming); two or more is an ambiguous misconfiguration that
fails construction. None set selects the dev ``EnvSecretProvider``. Selection is
fail-closed: once a backend is gated there is no silent fall-through to reading secrets
from the environment.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from keel_core.adapters.outbound.secrets.caching import parse_cache_ttl
from keel_core.adapters.outbound.secrets.env import EnvSecretProvider
from keel_core.adapters.outbound.secrets.openbao import (
    _DEFAULT_K8S_JWT_PATH,
    _DEFAULT_K8S_MOUNT,
    _DEFAULT_MOUNT,
    OpenBaoSecretProvider,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from keel_core.adapters.outbound.secrets.aws import AwsSecretsManagerSecretProvider
    from keel_core.adapters.outbound.secrets.gcp import GcpSecretManagerSecretProvider

_VAULT_ADDR = "KEEL_VAULT_ADDR"
_AWS_SECRET_ID = "KEEL_AWS_SECRET_ID"  # noqa: S105 - env var name, not a credential
_GCP_SECRET = "KEEL_GCP_SECRET"  # noqa: S105 - env var name, not a credential


def secret_provider_from_env(
    environ: Mapping[str, str] = os.environ,
) -> (
    EnvSecretProvider
    | OpenBaoSecretProvider
    | AwsSecretsManagerSecretProvider
    | GcpSecretManagerSecretProvider
):
    """Select the secret backend from the environment (ADR-0024 fail-closed selection).

    Counts the gating vars ``KEEL_VAULT_ADDR``, ``KEEL_AWS_SECRET_ID`` and
    ``KEEL_GCP_SECRET`` (non-empty after trimming). More than one -> fail construction
    ("multiple secret backends configured"). None -> ``EnvSecretProvider``. Exactly one ->
    that backend, whose own misconfiguration fails loudly at construction rather than
    falling back to the environment.
    """
    vault_addr = (environ.get(_VAULT_ADDR) or "").strip()
    aws_secret_id = (environ.get(_AWS_SECRET_ID) or "").strip()
    gcp_secret = (environ.get(_GCP_SECRET) or "").strip()

    gating = (
        (_VAULT_ADDR, vault_addr),
        (_AWS_SECRET_ID, aws_secret_id),
        (_GCP_SECRET, gcp_secret),
    )
    configured = [name for name, value in gating if value]
    if len(configured) > 1:
        msg = f"multiple secret backends configured: {', '.join(configured)}"
        raise ValueError(msg)
    if not configured:
        return EnvSecretProvider(environ=environ)

    cache_ttl_seconds = parse_cache_ttl(environ.get("KEEL_SECRET_CACHE_TTL_SECONDS"))
    if vault_addr:
        return OpenBaoSecretProvider(
            addr=vault_addr,
            path=environ.get("KEEL_VAULT_PATH", ""),
            token=environ.get("KEEL_VAULT_TOKEN"),
            role=environ.get("KEEL_VAULT_ROLE"),
            k8s_mount=environ.get("KEEL_VAULT_K8S_MOUNT", _DEFAULT_K8S_MOUNT),
            k8s_jwt_path=environ.get("KEEL_VAULT_K8S_JWT_PATH", _DEFAULT_K8S_JWT_PATH),
            mount=environ.get("KEEL_VAULT_MOUNT", _DEFAULT_MOUNT),
            namespace=environ.get("KEEL_VAULT_NAMESPACE"),
            cacert=environ.get("KEEL_VAULT_CACERT"),
            cache_ttl_seconds=cache_ttl_seconds,
        )

    if aws_secret_id:
        # Lazy import so selecting env/OpenBao never requires the optional boto3 `aws` extra.
        from keel_core.adapters.outbound.secrets.aws import AwsSecretsManagerSecretProvider

        return AwsSecretsManagerSecretProvider(
            secret_id=aws_secret_id,
            region=(environ.get("KEEL_AWS_REGION") or "").strip() or None,
            cache_ttl_seconds=cache_ttl_seconds,
        )

    # Lazy import so selecting another backend never requires the optional `gcp` extra.
    from keel_core.adapters.outbound.secrets.gcp import GcpSecretManagerSecretProvider

    return GcpSecretManagerSecretProvider(
        secret=gcp_secret,
        version=(environ.get("KEEL_GCP_SECRET_VERSION") or "").strip() or "latest",
        cache_ttl_seconds=cache_ttl_seconds,
    )
