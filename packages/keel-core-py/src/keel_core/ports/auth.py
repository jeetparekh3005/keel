"""Authentication port and principal model (platform.yaml auth contract)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True, slots=True)
class Principal:
    """An authenticated caller: subject plus granted scopes and roles."""

    subject: str
    scopes: frozenset[str] = field(default_factory=frozenset)
    roles: frozenset[str] = field(default_factory=frozenset)


class Authenticator(Protocol):
    """Verifies a credential and returns the Principal, or raises Unauthenticated."""

    def authenticate(self, credential: str) -> Principal:
        """Verify the credential; raise ``Unauthenticated`` on failure."""
        ...
