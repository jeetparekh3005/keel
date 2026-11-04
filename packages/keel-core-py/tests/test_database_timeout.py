"""Readiness ping must be bounded so /readyz fails fast, not hangs (audit #63)."""

import asyncio
import time

import pytest

from keel_core.adapters.outbound.persistence import Database


class _StalledConnection:
    async def __aenter__(self) -> "_StalledConnection":
        await asyncio.sleep(10)  # never completes within the test's timeout
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False


class _StalledEngine:
    def connect(self) -> _StalledConnection:
        return _StalledConnection()


async def test_ping_ok_on_live_datasource() -> None:
    db = Database("sqlite+aiosqlite://")
    assert await db.ping(timeout=5.0) is True
    await db.dispose()


async def test_ping_times_out_fast_when_connection_stalls(monkeypatch: pytest.MonkeyPatch) -> None:
    db = Database("sqlite+aiosqlite://")
    monkeypatch.setattr(db, "_engine", _StalledEngine())
    start = time.monotonic()
    result = await db.ping(timeout=0.05)
    elapsed = time.monotonic() - start
    assert result is False  # not ready, rather than raising or hanging
    assert elapsed < 1.0  # returned promptly, bounded by the timeout
