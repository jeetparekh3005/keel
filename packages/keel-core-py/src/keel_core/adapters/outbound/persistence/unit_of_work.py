"""Async unit of work: one session per transaction, commit on success else rollback."""

from __future__ import annotations

from types import TracebackType

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


class UnitOfWork:
    """Async context manager yielding a session; commits on clean exit, else rolls back."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        """Bind to a session factory (typically ``Database.session_factory``)."""
        self._session_factory = session_factory
        self._session: AsyncSession | None = None

    async def __aenter__(self) -> AsyncSession:
        """Open a new session for the transaction."""
        self._session = self._session_factory()
        return self._session

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Commit on a clean exit, else roll back; always close.

        We commit unconditionally on success rather than inferring "read-only" from
        session.new/dirty/deleted: those collections are empty after a flush() or for
        Core-DML (execute(insert/update/delete)), so a dirty-check would silently roll
        back those legitimate writes. A COMMIT on a read-only transaction writes no WAL
        and is effectively free, so correctness wins over skipping it.
        """
        session = self._session
        if session is None:
            return
        try:
            if exc_type is None:
                await session.commit()
            else:
                await session.rollback()
        finally:
            await session.close()
            self._session = None
