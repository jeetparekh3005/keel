"""<< aggregate_pascal >> use cases."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import uuid4

from keel_core.domain.errors import NotFound
from << python_package >>.domain.<< aggregate >> import << aggregate_pascal >>, << aggregate_pascal >>Repository


class << aggregate_pascal >>Service:
    """Create, fetch, and list << aggregate_plural >> via the repository port."""

    def __init__(self, repository: << aggregate_pascal >>Repository) -> None:
        """Bind to an << aggregate_pascal >>Repository implementation."""
        self._repository = repository

    async def create(self, name: str) -> << aggregate_pascal >>:
        """Create and persist a new << aggregate >>."""
        << aggregate >> = << aggregate_pascal >>(id=uuid4().hex, name=name)
        await self._repository.add(<< aggregate >>)
        return << aggregate >>

    async def get(self, << aggregate >>_id: str) -> << aggregate_pascal >>:
        """Return the << aggregate >>, raising ``NotFound`` if it does not exist."""
        << aggregate >> = await self._repository.get(<< aggregate >>_id)
        if << aggregate >> is None:
            msg = f"<< aggregate >> {<< aggregate >>_id} not found"
            raise NotFound(msg)
        return << aggregate >>

    async def list(self, *, limit: int = 50, offset: int = 0) -> Sequence[<< aggregate_pascal >>]:
        """Return a page of << aggregate_plural >>."""
        return await self._repository.list_all(limit=limit, offset=offset)
