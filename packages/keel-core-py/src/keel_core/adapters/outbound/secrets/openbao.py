"""OpenBao (Vault KV v2) SecretProvider adapter (ADR-0007, ADR-0023, ADR-0024).

Production secret backend spoken over the Vault KV v2 HTTP API, which OpenBao and
HashiCorp Vault share, so one adapter serves either endpoint. The client is a thin
hand-written wrapper over the stdlib HTTP client (``urllib.request``): the surface we
need is authenticate + read one KV v2 path, so no vault SDK dependency is taken on.

The adapter is a *loader* (``_OpenBaoLoader``) over the shared ``CachingSecretProvider``
core (ADR-0024 decision 3): the core owns the cache, the synchronous no-I/O ``get``, the
background refresh every ``KEEL_SECRET_CACHE_TTL_SECONDS``, and the fail-closed/no-leak
guarantees; the loader owns the Vault-specific auth, the token lease, and the KV v2 read.
A ``401``/``403`` during a refresh read triggers re-authentication and one retry inside
the loader, and a Kubernetes lease is renewed proactively a skew before it expires.
Selection is fail-closed: once ``KEEL_VAULT_ADDR`` is set there is no silent fall-through
to the environment.
"""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, cast

from keel_core.adapters.outbound.secrets.caching import CachingSecretProvider

if TYPE_CHECKING:
    from collections.abc import Mapping

    from keel_core.ports.logging import Logger

_DEFAULT_K8S_MOUNT = "kubernetes"
_DEFAULT_K8S_JWT_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
_DEFAULT_MOUNT = "secret"
_DEFAULT_CACHE_TTL_SECONDS = 60.0
_HTTP_TIMEOUT_SECONDS = 10.0
_LEASE_RENEW_SKEW_SECONDS = 10.0
_HTTP_NOT_FOUND = 404
_REAUTH_STATUSES = (401, 403)


class _VaultHttpError(Exception):
    """A non-success HTTP status from the Vault API, carrying the status code."""

    def __init__(self, status: int, detail: str = "") -> None:
        """Record the HTTP status and an optional response snippet."""
        self.status = status
        super().__init__(f"vault http {status}: {detail}".rstrip(": "))


class _OpenBaoLoader:
    """Loader that authenticates to OpenBao/Vault and reads one KV v2 path's field map."""

    def __init__(
        self,
        *,
        addr: str,
        path: str,
        token: str | None = None,
        role: str | None = None,
        k8s_mount: str = _DEFAULT_K8S_MOUNT,
        k8s_jwt_path: str = _DEFAULT_K8S_JWT_PATH,
        mount: str = _DEFAULT_MOUNT,
        namespace: str | None = None,
        cacert: str | None = None,
    ) -> None:
        """Validate config and build the TLS context; no network I/O until ``load``."""
        if not addr:
            msg = "KEEL_VAULT_ADDR must be set to use OpenBaoSecretProvider"
            raise ValueError(msg)
        if not path:
            msg = "KEEL_VAULT_PATH is required when KEEL_VAULT_ADDR is set"
            raise ValueError(msg)
        if not token and not role:
            msg = "no Vault auth configured: set KEEL_VAULT_TOKEN or KEEL_VAULT_ROLE"
            raise ValueError(msg)

        self._addr = addr.rstrip("/")
        self._path = path
        self._static_token = token
        self._role = role
        self._k8s_mount = k8s_mount
        self._k8s_jwt_path = k8s_jwt_path
        self._mount = mount
        self._namespace = namespace
        self._ssl_context = self._build_ssl_context(cacert)

        self._token: str | None = None
        self._authenticated = False
        self._lease_deadline: float | None = None  # monotonic; None => no expiry tracked

    @property
    def log_context(self) -> Mapping[str, object]:
        """Non-sensitive failure-log context: the KV path only, never a token."""
        return {"path": self._path}

    def load(self) -> Mapping[str, object]:
        """Authenticate if needed, renew a near-expiry lease, and read the KV v2 field map.

        On the first call authentication is eager. On later calls a near-expiry Kubernetes
        lease is renewed proactively, and a ``401``/``403`` read triggers re-login and one
        retry (static tokens surface the error). A ``404`` at the path is an empty map.
        """
        if not self._authenticated:
            self._authenticate()
            self._authenticated = True
        elif self._role and self._lease_expiring():
            self._authenticate()
        try:
            return self._read_fields()
        except _VaultHttpError as exc:
            if exc.status in _REAUTH_STATUSES and self._role:
                self._authenticate()
                return self._read_fields()
            raise

    # -- internals -----------------------------------------------------------------

    def _build_ssl_context(self, cacert: str | None) -> ssl.SSLContext | None:
        """Build a TLS context for ``https`` addresses, honoring ``KEEL_VAULT_CACERT``."""
        if not self._addr.lower().startswith("https://"):
            return None
        if not cacert:
            return ssl.create_default_context()
        if "-----BEGIN" in cacert:
            return ssl.create_default_context(cadata=cacert)
        return ssl.create_default_context(cafile=cacert)

    def _authenticate(self) -> None:
        """Resolve a client token via static token or Kubernetes login (ADR-0023)."""
        if self._static_token:
            self._token = self._static_token
            self._lease_deadline = None
            return
        # role is guaranteed set when the static token is absent (checked in __init__).
        jwt = Path(self._k8s_jwt_path).read_text(encoding="utf-8").strip()
        body = {"role": self._role, "jwt": jwt}
        payload = self._request(
            "POST",
            f"/v1/auth/{self._k8s_mount}/login",
            body=body,
            token=None,
        )
        auth = cast("Mapping[str, object]", payload.get("auth") or {})
        client_token = auth.get("client_token")
        if not isinstance(client_token, str) or not client_token:
            msg = "Kubernetes login returned no client_token"
            raise _VaultHttpError(500, msg)
        self._token = client_token
        lease = auth.get("lease_duration")
        if isinstance(lease, int) and lease > 0:
            self._lease_deadline = time.monotonic() + float(lease)
        else:
            self._lease_deadline = None

    def _lease_expiring(self) -> bool:
        """Whether a Kubernetes lease is within the renew skew of expiring."""
        if self._lease_deadline is None:
            return False
        return time.monotonic() >= self._lease_deadline - _LEASE_RENEW_SKEW_SECONDS

    def _read_fields(self) -> Mapping[str, object]:
        """Read the raw KV v2 field map at ``{mount}/data/{path}``; a 404 is an empty map."""
        try:
            payload = self._request(
                "GET",
                f"/v1/{self._mount}/data/{self._path}",
                token=self._token,
            )
        except _VaultHttpError as exc:
            if exc.status == _HTTP_NOT_FOUND:  # no secret at the path => empty map, not an error
                return {}
            raise
        data = cast("Mapping[str, object]", payload.get("data") or {})
        return cast("Mapping[str, object]", data.get("data") or {})

    def _request(
        self,
        method: str,
        path: str,
        *,
        token: str | None,
        body: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]:
        """Issue one Vault HTTP request; raise ``_VaultHttpError`` on a non-success status."""
        url = f"{self._addr}{path}"
        headers: dict[str, str] = {}
        data: bytes | None = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token:
            headers["X-Vault-Token"] = token
        if self._namespace:
            headers["X-Vault-Namespace"] = self._namespace
        request = urllib.request.Request(url, data=data, headers=headers, method=method)  # noqa: S310 - scheme is operator-controlled KEEL_VAULT_ADDR
        try:
            with urllib.request.urlopen(  # noqa: S310 - scheme is operator-controlled KEEL_VAULT_ADDR
                request,
                timeout=_HTTP_TIMEOUT_SECONDS,
                context=self._ssl_context,
            ) as response:
                raw = response.read()
                status = response.status
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:200]
            except Exception:
                detail = ""
            raise _VaultHttpError(exc.code, detail) from exc
        if not raw:
            return {}
        try:
            return cast("Mapping[str, object]", json.loads(raw))
        except ValueError:
            # A 2xx body that is not valid JSON may hold the secret payload; the error
            # must carry only status + path, never the body (ADR-0023 no-leak, read path).
            raise _VaultHttpError(status, path) from None


class OpenBaoSecretProvider(CachingSecretProvider):
    """A SecretProvider backed by an OpenBao/Vault KV v2 path, cached with background refresh."""

    def __init__(
        self,
        *,
        addr: str,
        path: str,
        token: str | None = None,
        role: str | None = None,
        k8s_mount: str = _DEFAULT_K8S_MOUNT,
        k8s_jwt_path: str = _DEFAULT_K8S_JWT_PATH,
        mount: str = _DEFAULT_MOUNT,
        namespace: str | None = None,
        cacert: str | None = None,
        cache_ttl_seconds: float = _DEFAULT_CACHE_TTL_SECONDS,
        logger: Logger | None = None,
        start_refresh: bool = True,
    ) -> None:
        """Authenticate, load the KV v2 field map once, and start the refresh thread.

        Exactly one of ``token`` (static) or ``role`` (Kubernetes auth) selects the auth
        method; a static token takes precedence. ``cacert`` is a PEM literal or a file
        path used to verify ``https`` endpoints (system roots otherwise). Construction
        performs blocking I/O and fails loudly on auth/transport errors so a misconfigured
        Vault never silently falls back to the environment (ADR-0023, fail-closed).
        ``start_refresh`` is a test seam to suppress the background thread.
        """
        loader = _OpenBaoLoader(
            addr=addr,
            path=path,
            token=token,
            role=role,
            k8s_mount=k8s_mount,
            k8s_jwt_path=k8s_jwt_path,
            mount=mount,
            namespace=namespace,
            cacert=cacert,
        )
        super().__init__(
            loader=loader,
            cache_ttl_seconds=cache_ttl_seconds,
            logger=logger,
            start_refresh=start_refresh,
        )
