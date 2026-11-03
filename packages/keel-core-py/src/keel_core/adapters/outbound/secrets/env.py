"""Environment-backed SecretProvider (dev default; prod uses OpenBao, ADR-0007).

This is the one place permitted to read the environment for secrets; everything
else goes through the SecretProvider port.
"""

from __future__ import annotations

import os
from collections.abc import Mapping


class EnvSecretProvider:
    """Reads ``<prefix><NAME>`` from an environment mapping (defaults to ``os.environ``)."""

    def __init__(
        self,
        *,
        prefix: str = "KEEL_SECRET_",
        environ: Mapping[str, str] | None = None,
    ) -> None:
        """Bind to a prefix and environment mapping (injected in tests)."""
        self._prefix = prefix
        self._environ: Mapping[str, str] = environ if environ is not None else os.environ

    def get(self, name: str) -> str:
        """Return the secret, or raise ``KeyError`` if absent."""
        value = self.get_optional(name)
        if value is None:
            msg = f"secret not found: {name}"
            raise KeyError(msg)
        return value

    def get_optional(self, name: str) -> str | None:
        """Return the secret, or None if absent."""
        return self._environ.get(f"{self._prefix}{name.upper()}")
