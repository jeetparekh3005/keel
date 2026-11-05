"""Async database: engine, session factory, readiness ping (platform.yaml persistence)."""

from __future__ import annotations

import asyncio

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

    def __init__(self, url: str, **engine_kwargs: object) -> None:
        """Create the async engine and session factory for ``url``.

        Extra keyword args (``echo``, ``pool_size``, ``pool_pre_ping``, ...) pass
        straight through to SQLAlchemy's ``create_async_engine``.
        """
        self._engine: AsyncEngine = create_async_engine(url, **engine_kwargs)
        self._session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
            self._engine,
            expire_on_commit=False,
        )

    @property
    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        """Factory for new async sessions."""
        return self._session_factory

    # Timeout is a deliberate param: ping encapsulates the bound and maps a
    # timeout to "not ready" (the readiness semantic), rather than making every
    # caller wrap it. ASYNC109 prefers caller-side asyncio.timeout; not here.
    async def ping(self, *, timeout: float = 5.0) -> bool:  # noqa: ASYNC109
        """Return True if the datasource answers a trivial query (readiness).

        Bounded by ``timeout`` seconds so ``/readyz`` fails fast instead of
        hanging when the pool is exhausted or a connection stalls. A timeout,
        like any driver error, reports *not ready* rather than raising.
        """
        try:
            async with asyncio.timeout(timeout):
                async with self._engine.connect() as connection:
                    await connection.execute(text("SELECT 1"))
        except (SQLAlchemyError, TimeoutError):
            return False
        return True

    def pool_stats(self) -> dict[str, int]:
        """Return connection-pool counts for saturation metrics.

        Keys: ``used`` (connections checked out, including any in-use overflow),
        ``idle`` (warm connections checked in and available), and ``max`` (base
        size + max overflow = the saturation denominator). ``idle`` is read from
        the pool's actual checked-in count, not ``size - used``, so it reflects
        connections that are really open. Pools without these counters (e.g.
        sqlite StaticPool) report zeros.
        """
        pool = self._engine.sync_engine.pool

        def _count(method: str) -> int:
            try:
                return int(getattr(pool, method)())
            except (AttributeError, TypeError):
                return 0

        # max_overflow is a configured attribute, not a counter; -1 means unbounded,
        # in which case there is no finite denominator (report size only).
        max_overflow = getattr(pool, "_max_overflow", 0)
        if not isinstance(max_overflow, int) or max_overflow < 0:
            max_overflow = 0
        return {
            "used": _count("checkedout"),
            "idle": _count("checkedin"),
            "max": _count("size") + max_overflow,
        }

    async def create_all(self) -> None:
        """Create all mapped tables. For dev/tests; production uses migrations."""
        async with self._engine.begin() as connection:
            await connection.run_sync(Entity.metadata.create_all)

    async def dispose(self) -> None:
        """Dispose of the engine and its connection pool."""
        await self._engine.dispose()
