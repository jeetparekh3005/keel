"""System clock adapter (platform.yaml ports.driven: Clock)."""

from __future__ import annotations

from datetime import UTC, datetime


class SystemClock:
    """Clock backed by the system wall clock, always timezone-aware UTC."""

    def now(self) -> datetime:
        """Return the current UTC time."""
        return datetime.now(UTC)
