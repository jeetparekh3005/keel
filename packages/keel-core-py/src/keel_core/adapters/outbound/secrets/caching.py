"""Shared caching core for cloud/Vault SecretProvider backends (ADR-0023, ADR-0024).

ADR-0024 decision 3: one caching engine, three loaders. The port's ``get`` is
synchronous, so it must never perform I/O. ``CachingSecretProvider`` loads a field map
once at construction (eager, may block, fails loudly on error), serves ``get`` /
``get_optional`` from that in-memory cache with no I/O, and re-invokes its *loader* every
``KEEL_SECRET_CACHE_TTL_SECONDS`` on a daemon thread. A failed refresh keeps serving the
last good map rather than taking the service down; the token/credential and secret values
never appear in a log line (ADR-0023 no-leak invariant).

A *loader* authenticates and returns the raw (uncoerced) field map; the core applies the
ADR-0023 scalar coercion. Backend-specific concerns (Vault token leases, AWS SigV4) live
inside the loader; the core just calls ``load()`` and never sees a credential.
"""

from __future__ import annotations

import json
import threading
from typing import TYPE_CHECKING, Protocol

import structlog

if TYPE_CHECKING:
    from collections.abc import Mapping

    from keel_core.ports.logging import Logger

_DEFAULT_CACHE_TTL_SECONDS = 60.0
_THREAD_JOIN_TIMEOUT_SECONDS = 10.0
_TTL_ERROR = "KEEL_SECRET_CACHE_TTL_SECONDS must be a positive integer"


def coerce_field(value: object) -> str | None:
    """Coerce a raw field to its canonical secret string, or None if not a scalar.

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


def parse_cache_ttl(raw: str | None) -> float:
    """Parse ``KEEL_SECRET_CACHE_TTL_SECONDS`` to a positive integer, or default when unset.

    ADR-0024 shared cache core: a non-positive or unparseable value fails construction
    (fail-closed misconfig); only a truly unset value falls back to the 60-second default.
    """
    if raw is None:
        return _DEFAULT_CACHE_TTL_SECONDS
    try:
        ttl = int(raw)
    except ValueError:
        raise ValueError(_TTL_ERROR) from None
    if ttl <= 0:
        raise ValueError(_TTL_ERROR)
    return float(ttl)


class SecretLoader(Protocol):
    """Authenticates and returns a backend's raw field map for the caching core.

    ``load`` returns the raw (uncoerced) field map; a not-found secret is an empty map,
    not an error (mirroring an empty environment). Any other failure raises so the core
    can keep serving the last good map. ``log_context`` is non-sensitive context (a path
    or secret id, never a credential) attached to refresh-failure log lines.
    """

    @property
    def log_context(self) -> Mapping[str, object]:
        """Non-sensitive fields identifying the secret for failure logs (no credentials)."""
        ...

    def load(self) -> Mapping[str, object]:
        """Authenticate if needed and return the raw field map; not-found -> empty map."""
        ...


class CachingSecretProvider:
    """A SecretProvider that caches a loader's field map and refreshes it in the background."""

    def __init__(
        self,
        *,
        loader: SecretLoader,
        cache_ttl_seconds: float = _DEFAULT_CACHE_TTL_SECONDS,
        logger: Logger | None = None,
        start_refresh: bool = True,
    ) -> None:
        """Load the field map once (eager, may block) and start the refresh thread.

        ``cache_ttl_seconds`` must be positive; a non-positive value fails before any I/O
        (fail-closed misconfig). The eager first load propagates its error so a
        misconfigured backend fails loudly rather than falling back to the environment
        (ADR-0023/0024 fail-closed). ``start_refresh`` is a test seam to suppress the
        background thread.
        """
        if cache_ttl_seconds <= 0:  # fail-closed: no "0 disables refresh", no silent clamp
            raise ValueError(_TTL_ERROR)

        self._loader = loader
        self._ttl = cache_ttl_seconds
        self._logger: Logger = logger or structlog.get_logger("keel.secrets")

        self._lock = threading.Lock()
        self._fields: Mapping[str, str] = {}

        # Eager first load (may block). Failures propagate: fail-closed at construction.
        self._fields = self._coerce(self._loader.load())

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        if start_refresh:  # TTL is guaranteed positive; the refresh thread always runs
            self._thread = threading.Thread(
                target=self._refresh_loop,
                name="keel-secret-refresh",
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
            thread.join(timeout=_THREAD_JOIN_TIMEOUT_SECONDS)

    def __enter__(self) -> CachingSecretProvider:
        """Enter a context that stops the refresh thread on exit."""
        return self

    def __exit__(self, *_exc: object) -> None:
        """Stop the refresh thread when leaving the context."""
        self.close()

    # -- internals -----------------------------------------------------------------

    @staticmethod
    def _coerce(raw: Mapping[str, object]) -> Mapping[str, str]:
        """Apply ADR-0023 scalar coercion; object/array/null fields become absent."""
        coerced: dict[str, str] = {}
        for key, value in raw.items():
            field = coerce_field(value)
            if field is not None:  # object/array/null fields are not scalar secrets => absent
                coerced[str(key)] = field
        return coerced

    def _refresh_loop(self) -> None:
        """Re-invoke the loader every TTL until stopped (daemon thread body)."""
        while not self._stop.wait(self._ttl):
            self._refresh_once()

    def _refresh_once(self) -> None:
        """Reload the field map; on any failure keep the last good map and log (no secret)."""
        try:
            fields = self._coerce(self._loader.load())
        except Exception:
            # No-leak: context is non-sensitive loader fields only, never a credential or
            # a response body (ADR-0023). The loader owns any re-auth/retry before it raises.
            self._logger.warning(
                "secret refresh failed, serving cached secrets",
                **self._loader.log_context,
            )
            return
        with self._lock:
            self._fields = fields
