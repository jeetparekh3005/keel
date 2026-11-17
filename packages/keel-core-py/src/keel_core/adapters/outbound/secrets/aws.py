"""AWS Secrets Manager SecretProvider adapter (ADR-0024).

A *loader* (``_AwsSecretsManagerLoader``) over the shared ``CachingSecretProvider`` core:
the core owns the cache, the synchronous no-I/O ``get``, the background refresh every
``KEEL_SECRET_CACHE_TTL_SECONDS``, and the fail-closed/no-leak guarantees; the loader
reads one configured secret through boto3 and parses its ``SecretString`` as a JSON object
into the field map (ADR-0023 coercion applied by the core).

ADR-0024 reverses ADR-0023's thin-client rule for the cloud backends: boto3 implements
SigV4 request signing and resolves the default credential chain (env, IRSA, instance
profile, SSO), which is exactly the security-sensitive machinery not worth hand-rolling.
No keel-managed credentials and no custom endpoint knob: boto3 honors the standard
``AWS_ENDPOINT_URL_SECRETS_MANAGER`` env var (used to point at LocalStack in tests).

boto3 is an optional dependency (the ``aws`` extra); it is imported lazily inside the
loader so importing this module (and the secrets package) never requires it.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from keel_core.adapters.outbound.secrets.caching import (
    _DEFAULT_CACHE_TTL_SECONDS,
    CachingSecretProvider,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from mypy_boto3_secretsmanager import SecretsManagerClient

    from keel_core.ports.logging import Logger


def _build_client(region: str | None) -> SecretsManagerClient:
    """Create a boto3 Secrets Manager client using the default credential chain.

    ``region`` is passed through when set; otherwise boto3 resolves it (env,
    ``AWS_REGION``, config). Imported lazily so the ``aws`` extra is only needed when the
    AWS backend is actually constructed.
    """
    import boto3  # lazy: boto3 is the optional `aws` extra, not required to import this module

    return boto3.client("secretsmanager", region_name=region)


class _AwsSecretsManagerLoader:
    """Loader that reads one AWS Secrets Manager secret as a JSON object field map."""

    def __init__(
        self,
        *,
        secret_id: str,
        region: str | None = None,
        client: SecretsManagerClient | None = None,
    ) -> None:
        """Bind to a secret id (name or ARN); build a boto3 client unless one is injected.

        ``client`` is a test seam (a stubbed boto3 client). No network I/O happens here;
        the first ``GetSecretValue`` is driven by the core's eager load.
        """
        if not secret_id:
            msg = "KEEL_AWS_SECRET_ID must be set to use AwsSecretsManagerSecretProvider"
            raise ValueError(msg)
        self._secret_id = secret_id
        self._client = client if client is not None else _build_client(region)

    @property
    def log_context(self) -> Mapping[str, object]:
        """Non-sensitive failure-log context: the secret id only, never a credential."""
        return {"secret_id": self._secret_id}

    def load(self) -> Mapping[str, object]:
        """Read ``GetSecretValue`` and parse ``SecretString`` as a JSON object field map.

        ``ResourceNotFoundException`` -> empty map (all absent), mirroring Vault's
        404-as-empty. A ``SecretBinary``-only secret or a non-object / invalid JSON payload
        fails loudly: a secret meant to back ``get(name)`` must be a JSON object of fields.
        Error messages carry only the secret id, never the payload (ADR-0023 no-leak).
        """
        try:
            response = self._client.get_secret_value(SecretId=self._secret_id)
        except self._client.exceptions.ResourceNotFoundException:
            return {}
        # SecretString is absent for a SecretBinary-only secret (the stubs type it as always
        # present, so test membership rather than `is None`, which mypy sees as unreachable).
        if not response.get("SecretString"):
            msg = f"AWS secret {self._secret_id} has no SecretString (SecretBinary is unsupported)"
            raise ValueError(msg)
        secret_string = response["SecretString"]
        try:
            parsed = json.loads(secret_string)
        except ValueError:
            # No-leak: never echo the payload, and do not chain the JSONDecodeError
            # (whose .doc holds the secret) as the cause.
            msg = f"AWS secret {self._secret_id} is not valid JSON"
            raise ValueError(msg) from None
        if not isinstance(parsed, dict):
            # A non-object payload is a misconfiguration (the wrong secret shape), not a
            # programming type error, so ValueError matches the other fail-closed paths.
            msg = f"AWS secret {self._secret_id} is not a JSON object of fields"
            raise ValueError(msg)  # noqa: TRY004 - config error, not a type error
        return parsed


class AwsSecretsManagerSecretProvider(CachingSecretProvider):
    """A SecretProvider backed by one AWS Secrets Manager secret, cached with refresh."""

    def __init__(
        self,
        *,
        secret_id: str,
        region: str | None = None,
        client: SecretsManagerClient | None = None,
        cache_ttl_seconds: float = _DEFAULT_CACHE_TTL_SECONDS,
        logger: Logger | None = None,
        start_refresh: bool = True,
    ) -> None:
        """Load the secret's field map once and start the background refresh thread.

        Construction performs blocking I/O (``GetSecretValue``) and fails loudly on an
        auth/permission/parse error so a misconfigured AWS backend never silently falls
        back to the environment (ADR-0024, fail-closed). ``client`` is a test seam;
        ``start_refresh`` suppresses the background thread in tests.
        """
        loader = _AwsSecretsManagerLoader(secret_id=secret_id, region=region, client=client)
        super().__init__(
            loader=loader,
            cache_ttl_seconds=cache_ttl_seconds,
            logger=logger,
            start_refresh=start_refresh,
        )
