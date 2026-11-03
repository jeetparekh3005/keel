"""In-memory test doubles for keel-core ports."""

from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import datetime

from keel_core.adapters.outbound.logging import StructuredLogger
from keel_core.domain.errors import Unauthenticated
from keel_core.ports.auth import Principal


@dataclass
class FrozenClock:
    """Clock that always returns a fixed instant."""

    instant: datetime

    def now(self) -> datetime:
        """Return the fixed instant."""
        return self.instant


class StubAuthenticator:
    """Authenticator backed by a fixed ``credential -> Principal`` mapping."""

    def __init__(self, principals: dict[str, Principal]) -> None:
        """Initialize with the set of valid credentials and their principals."""
        self._principals = principals

    def authenticate(self, credential: str) -> Principal:
        """Return the mapped principal, or raise ``Unauthenticated``."""
        principal = self._principals.get(credential)
        if principal is None:
            msg = "invalid credential"
            raise Unauthenticated(msg)
        return principal


def capturing_logger(
    *,
    service: str = "test",
    version: str = "0.0.0",
) -> tuple[StructuredLogger, io.StringIO]:
    """Return a :class:`StructuredLogger` writing to an in-memory buffer, with the buffer."""
    buffer = io.StringIO()
    logger = StructuredLogger(service=service, version=version, stream=buffer)
    return logger, buffer
