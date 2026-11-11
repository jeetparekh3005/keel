"""<< aggregate_pascal >> aggregate and its repository port (pure domain; no ORM, no I/O)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class << aggregate_pascal >>:
    """An << aggregate >> owned by the service."""

    id: str
    name: str


class << aggregate_pascal >>Repository(Protocol):
    """Persistence operations for :class:`<< aggregate_pascal >>` (implemented by an adapter)."""

    async def add(self, << aggregate >>: << aggregate_pascal >>) -> None:
        """Persist a new << aggregate >>."""
        ...

    async def get(self, << aggregate >>_id: str) -> << aggregate_pascal >> | None:
        """Return the << aggregate >>, or None if absent."""
        ...

    async def list_all(self, *, limit: int = 50, offset: int = 0) -> Sequence[<< aggregate_pascal >>]:
        """Return a page of << aggregate_plural >>."""
        ...
