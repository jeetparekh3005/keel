"""OpenBao (Vault KV v2) SecretProvider adapter (ADR-0007, ADR-0023).

Production secret backend spoken over the Vault KV v2 HTTP API, which OpenBao and
HashiCorp Vault share, so one adapter serves either endpoint. The client is a thin
hand-written wrapper over the stdlib HTTP client (``urllib.request``): the surface we
need is authenticate + read one KV v2 path, so no vault SDK dependency is taken on.

The port's ``get`` is synchronous, so it must never perform I/O. At construction the
adapter authenticates (token or Kubernetes auth) and loads the path's field map into an
in-memory cache; ``get``/``get_optional`` serve from that cache. A daemon thread re-reads
the path every ``KEEL_VAULT_CACHE_TTL_SECONDS``; a ``401``/``403`` during refresh triggers
re-authentication and one retry, and a failed refresh keeps serving the last good map
rather than taking the service down. Selection is fail-closed: once ``KEEL_VAULT_ADDR`` is
set there is no silent fall-through to the environment.
"""

from __future__ import annotations

import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, cast

import structlog

from keel_core.adapters.outbound.secrets.env import EnvSecretProvider

if TYPE_CHECKING:
    from keel_core.ports.logging import Logger

_DEFAULT_K8S_MOUNT = "kubernetes"
_DEFAULT_K8S_JWT_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
_DEFAULT_MOUNT = "secret"
_DEFAULT_CACHE_TTL_SECONDS = 60.0
_HTTP_TIMEOUT_SECONDS = 10.0
_LEASE_RENEW_SKEW_SECONDS = 10.0
_HTTP_NOT_FOUND = 404
_REAUTH_STATUSES = (401, 403)


def _coerce_field(value: object) -> str | None:
    """Coerce a KV v2 field to its canonical secret string, or None if not a scalar.

    ADR-0023 field coercion: a JSON string is returned verbatim; a JSON number is
    rendered as its JSON number text (``3`` -> ``"3"``, ``3.5`` -> ``"3.5"``); a JSON
    boolean becomes lowercase ``"true"``/``"false"``. A JSON object, array, or null is
    not a secret scalar and is reported as absent (``None``). ``bool`` is tested before
    the numeric branch because it is a subclass of ``int``.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return json.dumps(value)
    return None


class _VaultHttpError(Exception):
    """A non-success HTTP status from the Vault API, carrying the status code."""

    def __init__(self, status: int, detail: str = "") -> None:
        """Record the HTTP status and an optional response snippet."""
        self.status = status
        super().__init__(f"vault http {status}: {detail}".rstrip(": "))


class OpenBaoSecretProvider:
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
        if not addr:
            msg = "KEEL_VAULT_ADDR must be set to use OpenBaoSecretProvider"
            raise ValueError(msg)
        if not path:
            msg = "KEEL_VAULT_PATH is required when KEEL_VAULT_ADDR is set"
            raise ValueError(msg)
        if not token and not role:
            msg = "no Vault auth configured: set KEEL_VAULT_TOKEN or KEEL_VAULT_ROLE"
            raise ValueError(msg)
        if cache_ttl_seconds <= 0:  # fail-closed: no "0 disables refresh", no silent clamp
            msg = "KEEL_VAULT_CACHE_TTL_SECONDS must be a positive integer"
            raise ValueError(msg)

        self._addr = addr.rstrip("/")
        self._path = path
        self._static_token = token
        self._role = role
        self._k8s_mount = k8s_mount
        self._k8s_jwt_path = k8s_jwt_path
        self._mount = mount
        self._namespace = namespace
        self._ttl = cache_ttl_seconds
        self._logger: Logger = logger or structlog.get_logger("keel.secrets")
        self._ssl_context = self._build_ssl_context(cacert)

        self._lock = threading.Lock()
        self._token: str | None = None
        self._lease_deadline: float | None = None  # monotonic; None => no expiry tracked
        self._fields: Mapping[str, str] = {}

        # Eager first load (may block). Failures propagate: fail-closed at construction.
        self._authenticate()
        self._fields = self._read_fields()

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        if start_refresh:  # TTL is guaranteed positive; the refresh thread always runs
            self._thread = threading.Thread(
                target=self._refresh_loop,
                name="keel-openbao-refresh",
                daemon=True,
            )
            self._thread.start()

    def get(self, name: str) -> str:
        """Return the secret field, or raise ``KeyError`` if absent. Serves from cache; no I/O."""
        value = self.get_optional(name)
        if value is None:
            msg = f"secret not found: {name}"
            raise KeyError(msg)
        return value

    def get_optional(self, name: str) -> str | None:
        """Return the secret field, or None if absent. Serves from cache; no I/O."""
        with self._lock:
            return self._fields.get(name)

    def close(self) -> None:
        """Stop the background refresh thread (idempotent)."""
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=_HTTP_TIMEOUT_SECONDS)

    def __enter__(self) -> OpenBaoSecretProvider:
        """Enter a context that stops the refresh thread on exit."""
        return self

    def __exit__(self, *_exc: object) -> None:
        """Stop the refresh thread when leaving the context."""
        self.close()

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

    def _read_fields(self) -> Mapping[str, str]:
        """Read the KV v2 field map at ``{mount}/data/{path}``; a 404 is an empty map."""
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
        inner = cast("Mapping[str, object]", data.get("data") or {})
        coerced: dict[str, str] = {}
        for key, value in inner.items():
            field = _coerce_field(value)
            if field is not None:  # object/array/null fields are not scalar secrets => absent
                coerced[str(key)] = field
        return coerced

    def _refresh_loop(self) -> None:
        """Re-read the field map every TTL until stopped (daemon thread body)."""
        while not self._stop.wait(self._ttl):
            self._refresh_once()

    def _refresh_once(self) -> None:
        """Re-read the field map; re-auth+retry on 401/403, keep last good on any failure."""
        try:
            if self._role and self._lease_expiring():
                self._authenticate()
            fields = self._read_fields()
        except _VaultHttpError as exc:
            if exc.status in _REAUTH_STATUSES and self._role:
                try:
                    self._authenticate()
                    fields = self._read_fields()
                except Exception:
                    self._logger.warning(
                        "openbao refresh re-auth failed, serving cached secrets",
                        path=self._path,
                    )
                    return
            else:
                self._logger.warning(
                    "openbao refresh failed, serving cached secrets",
                    path=self._path,
                    status=exc.status,
                )
                return
        except Exception:
            self._logger.warning(
                "openbao refresh failed, serving cached secrets",
                path=self._path,
            )
            return
        with self._lock:
            self._fields = fields

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


def _parse_cache_ttl(raw: str | None) -> float:
    """Parse ``KEEL_VAULT_CACHE_TTL_SECONDS`` to a positive integer, or default when unset.

    ADR-0023: a non-positive or unparseable value fails construction (fail-closed misconfig);
    only a truly unset value falls back to the 60-second default.
    """
    if raw is None:
        return _DEFAULT_CACHE_TTL_SECONDS
    try:
        ttl = int(raw)
    except ValueError:
        msg = "KEEL_VAULT_CACHE_TTL_SECONDS must be a positive integer"
        raise ValueError(msg) from None
    if ttl <= 0:
        msg = "KEEL_VAULT_CACHE_TTL_SECONDS must be a positive integer"
        raise ValueError(msg)
    return float(ttl)


def secret_provider_from_env(
    environ: Mapping[str, str] = os.environ,
) -> EnvSecretProvider | OpenBaoSecretProvider:
    """Return the OpenBao provider when ``KEEL_VAULT_ADDR`` is set, else the env provider.

    Fail-closed (ADR-0023): once ``KEEL_VAULT_ADDR`` is set the OpenBao backend is used and
    a misconfiguration fails loudly at construction rather than falling back to reading
    secrets from the environment.
    """
    addr = environ.get("KEEL_VAULT_ADDR")
    if not addr:
        return EnvSecretProvider(environ=environ)
    return OpenBaoSecretProvider(
        addr=addr,
        path=environ.get("KEEL_VAULT_PATH", ""),
        token=environ.get("KEEL_VAULT_TOKEN"),
        role=environ.get("KEEL_VAULT_ROLE"),
        k8s_mount=environ.get("KEEL_VAULT_K8S_MOUNT", _DEFAULT_K8S_MOUNT),
        k8s_jwt_path=environ.get("KEEL_VAULT_K8S_JWT_PATH", _DEFAULT_K8S_JWT_PATH),
        mount=environ.get("KEEL_VAULT_MOUNT", _DEFAULT_MOUNT),
        namespace=environ.get("KEEL_VAULT_NAMESPACE"),
        cacert=environ.get("KEEL_VAULT_CACERT"),
        cache_ttl_seconds=_parse_cache_ttl(environ.get("KEEL_VAULT_CACHE_TTL_SECONDS")),
    )
