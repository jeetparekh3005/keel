"""Async database: engine, session factory, readiness ping (platform.yaml persistence)."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from keel_core.adapters.outbound.persistence.base import Entity


class Database:
    """Owns the async engine and session factory for one datasource."""

    def __init__(self, url: str, *, echo: bool = False, **engine_kwargs: object) -> None:
        """Create the async engine and session factory for ``url``."""
        self._engine: AsyncEngine = create_async_engine(url, echo=echo, **engine_kwargs)
        self._session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
            self._engine,
            expire_on_commit=False,
        )

    @property
    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        """Factory for new async sessions."""
        return self._session_factory

    async def ping(self) -> bool:
        """Return True if the datasource answers a trivial query (readiness)."""
        try:
            async with self._engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
        except SQLAlchemyError:
            return False
        return True

    async def create_all(self) -> None:
        """Create all mapped tables. For dev/tests; production uses migrations."""
        async with self._engine.begin() as connection:
            await connection.run_sync(Entity.metadata.create_all)

    async def dispose(self) -> None:
        """Dispose of the engine and its connection pool."""
        await self._engine.dispose()
