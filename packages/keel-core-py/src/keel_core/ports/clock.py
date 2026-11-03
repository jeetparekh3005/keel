"""Clock port: injectable time for testability (platform.yaml ports.driven)."""

from __future__ import annotations

from datetime import datetime
from typing import Protocol


class Clock(Protocol):
    """Provides the current time as a timezone-aware UTC datetime."""

    def now(self) -> datetime:
        """Return the current time (timezone-aware, UTC)."""
        ...
