"""Logger port: structured logging per the platform.yaml logging contract."""

from __future__ import annotations

from typing import Protocol


class Logger(Protocol):
    """Structured, level-based logger. Implementations emit the contract schema."""

    def debug(self, message: str, **fields: object) -> None:
        """Log at debug level with structured fields."""
        ...

    def info(self, message: str, **fields: object) -> None:
        """Log at info level with structured fields."""
        ...

    def warning(self, message: str, **fields: object) -> None:
        """Log at warn level with structured fields."""
        ...

    def error(self, message: str, **fields: object) -> None:
        """Log at error level with structured fields."""
        ...

    def exception(self, message: str, **fields: object) -> None:
        """Log at error level including the active exception's traceback."""
        ...
