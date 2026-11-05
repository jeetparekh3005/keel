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
        """Commit pending writes on a clean exit, else roll back; always close.

        A read-only block (no new/dirty/deleted objects) is rolled back rather than
        committed, so GET/LIST requests do not pay a COMMIT round trip per call.
        """
        session = self._session
        if session is None:
            return
        try:
            if exc_type is None and (session.new or session.dirty or session.deleted):
                await session.commit()
            else:
                await session.rollback()
        finally:
            await session.close()
            self._session = None
