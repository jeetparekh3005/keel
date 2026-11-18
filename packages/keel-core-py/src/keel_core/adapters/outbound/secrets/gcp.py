"""GCP Secret Manager SecretProvider adapter (ADR-0024).

A *loader* (``_GcpSecretManagerLoader``) over the shared ``CachingSecretProvider`` core:
the core owns the cache, the synchronous no-I/O ``get``, the background refresh every
``KEEL_SECRET_CACHE_TTL_SECONDS``, and the fail-closed/no-leak guarantees; the loader
reads one configured secret version through google-cloud-secret-manager and parses its
UTF-8 payload as a JSON object into the field map (ADR-0023 coercion applied by the core).

ADR-0024 reverses ADR-0023's thin-client rule for the cloud backends: the SDK implements
the OAuth2 token exchange and resolves Application Default Credentials (env, Workload
Identity, metadata server), which is exactly the security-sensitive machinery not worth
hand-rolling. No keel-managed credentials: only the secret resource name and version are
configured.

google-cloud-secret-manager is an optional dependency (the ``gcp`` extra); it is imported
lazily inside the client builder so importing this module (and the secrets package) never
requires it.
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

    from google.api_core.retry import Retry
    from google.cloud.secretmanager import SecretManagerServiceClient

    from keel_core.ports.logging import Logger

_DEFAULT_SECRET_VERSION = "latest"  # noqa: S105 - version alias, not a credential
# Hard per-request timeout and an overall retry cap so a wedged/unreachable Secret Manager
# or a degraded ADC/metadata path fails the eager startup load fast instead of hanging on
# the SDK's generous defaults. This is ADR-0023's hard-timeout rule, the same bound applied
# to the OpenBao and AWS adapters.
_REQUEST_TIMEOUT_SECONDS = 10.0
_RETRY_TIMEOUT_SECONDS = 20.0


def _build_client() -> SecretManagerServiceClient:
    """Create a Secret Manager client using Application Default Credentials.

    Imported lazily so the ``gcp`` extra is only needed when the GCP backend is actually
    constructed. ADC resolution (env, Workload Identity, metadata server) is the SDK's
    default; no keel-managed credentials are passed.
    """
    from google.cloud import secretmanager  # lazy: the optional `gcp` extra

    return secretmanager.SecretManagerServiceClient()


def _bounded_retry() -> Retry:
    """A retry policy capped in total duration so a degraded endpoint fails fast.

    Keeps the SDK's default transient-error predicate but bounds the overall time so the
    eager startup load cannot stall on the SDK's minutes-long default retry deadline.
    """
    from google.api_core.retry import Retry  # lazy: the optional `gcp` extra

    return Retry(
        initial=0.5,
        maximum=4.0,
        multiplier=2.0,
        timeout=_RETRY_TIMEOUT_SECONDS,
    )


def _resource_name(secret: str, version: str) -> str:
    """Build the ``.../versions/<v>`` resource name to access.

    ``KEEL_GCP_SECRET`` is either a secret resource name (``projects/<p>/secrets/<name>``),
    to which ``/versions/<version>`` is appended, or already a fully qualified version
    (``.../versions/<v>``), which is used verbatim (the version env var is then ignored).
    """
    if "/versions/" in secret:
        return secret
    return f"{secret}/versions/{version}"


class _GcpSecretManagerLoader:
    """Loader that reads one GCP Secret Manager secret version as a JSON object field map."""

    def __init__(
        self,
        *,
        secret: str,
        version: str = _DEFAULT_SECRET_VERSION,
        client: SecretManagerServiceClient | None = None,
    ) -> None:
        """Bind to a secret resource name; build an ADC client unless one is injected.

        ``client`` is a test seam (a mocked ``SecretManagerServiceClient``). No network I/O
        and no ADC/metadata lookup happens here; the first ``AccessSecretVersion`` is driven
        by the core's eager load.
        """
        if not secret:
            msg = "KEEL_GCP_SECRET must be set to use GcpSecretManagerSecretProvider"
            raise ValueError(msg)
        self._name = _resource_name(secret, version or _DEFAULT_SECRET_VERSION)
        self._client = client if client is not None else _build_client()
        self._retry = _bounded_retry()

    @property
    def log_context(self) -> Mapping[str, object]:
        """Non-sensitive failure-log context: the secret resource name only, no credentials."""
        return {"secret": self._name}

    def load(self) -> Mapping[str, object]:
        """Access the secret version and parse its UTF-8 payload as a JSON object field map.

        ``NOT_FOUND`` -> empty map (all absent), mirroring Vault's 404-as-empty. A
        non-UTF-8, non-object, or otherwise invalid JSON payload fails loudly: a secret
        meant to back ``get(name)`` must be a UTF-8 JSON object of fields. Error messages
        carry only the resource name, never the payload or a credential (ADR-0023 no-leak).
        """
        from google.api_core.exceptions import NotFound  # lazy: the optional `gcp` extra

        try:
            response = self._client.access_secret_version(
                name=self._name,
                timeout=_REQUEST_TIMEOUT_SECONDS,
                retry=self._retry,
            )
        except NotFound:
            return {}
        raw_bytes = response.payload.data
        try:
            text = bytes(raw_bytes).decode("utf-8")
        except UnicodeDecodeError:
            # No-leak: never echo the payload and do not chain the decode error (whose
            # .object holds the raw bytes) as the cause.
            msg = f"GCP secret {self._name} payload is not valid UTF-8"
            raise ValueError(msg) from None
        try:
            parsed = json.loads(text)
        except ValueError:
            # No-leak: never echo the payload, and do not chain the JSONDecodeError
            # (whose .doc holds the secret) as the cause.
            msg = f"GCP secret {self._name} is not valid JSON"
            raise ValueError(msg) from None
        if not isinstance(parsed, dict):
            # A non-object payload is a misconfiguration (the wrong secret shape), not a
            # programming type error, so ValueError matches the other fail-closed paths.
            msg = f"GCP secret {self._name} is not a JSON object of fields"
            raise ValueError(msg)  # noqa: TRY004 - config error, not a type error
        return parsed


class GcpSecretManagerSecretProvider(CachingSecretProvider):
    """A SecretProvider backed by one GCP Secret Manager secret, cached with refresh."""

    def __init__(
        self,
        *,
        secret: str,
        version: str = _DEFAULT_SECRET_VERSION,
        client: SecretManagerServiceClient | None = None,
        cache_ttl_seconds: float = _DEFAULT_CACHE_TTL_SECONDS,
        logger: Logger | None = None,
        start_refresh: bool = True,
    ) -> None:
        """Load the secret's field map once and start the background refresh thread.

        Construction performs blocking I/O (``AccessSecretVersion``) and fails loudly on an
        auth/permission/parse error so a misconfigured GCP backend never silently falls back
        to the environment (ADR-0024, fail-closed). ``client`` is a test seam;
        ``start_refresh`` suppresses the background thread in tests.
        """
        loader = _GcpSecretManagerLoader(secret=secret, version=version, client=client)
        super().__init__(
            loader=loader,
            cache_ttl_seconds=cache_ttl_seconds,
            logger=logger,
            start_refresh=start_refresh,
        )
