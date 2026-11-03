"""Structured JSON logging adapter (platform.yaml logging contract).

Emits one JSON object per event with the contract's required fields, injects
correlation ids from :mod:`keel_core.context`, and redacts secret-like keys so
they never reach a log sink.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import IO

from keel_core import context

_REDACT_KEYS: frozenset[str] = frozenset(
    {"password", "token", "secret", "authorization", "set-cookie", "api_key", "pii"},
)
_REDACTED = "[REDACTED]"


def _redact(fields: dict[str, object]) -> dict[str, object]:
    return {k: (_REDACTED if k.lower() in _REDACT_KEYS else v) for k, v in fields.items()}


class StructuredLogger:
    """Writes contract-schema JSON log lines to a stream (stdout by default)."""

    def __init__(
        self,
        *,
        service: str,
        version: str,
        level: str = "info",
        stream: IO[str] | None = None,
    ) -> None:
        """Create a logger bound to a service name, version, and minimum level."""
        self._service = service
        self._version = version
        self._level = logging.getLevelNamesMapping().get(level.upper(), logging.INFO)
        self._stream = stream if stream is not None else sys.stdout

    def _emit(self, level: int, level_name: str, message: str, fields: dict[str, object]) -> None:
        if level < self._level:
            return
        record: dict[str, object] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": level_name,
            "message": message,
            "service": self._service,
            "version": self._version,
            "trace_id": context.trace_id_var.get(),
            "span_id": context.span_id_var.get(),
        }
        request_id = context.request_id_var.get()
        if request_id is not None:
            record["request_id"] = request_id
        record.update(_redact(fields))
        self._stream.write(json.dumps(record, default=str) + "\n")

    def debug(self, message: str, **fields: object) -> None:
        """Log at debug level."""
        self._emit(logging.DEBUG, "debug", message, fields)

    def info(self, message: str, **fields: object) -> None:
        """Log at info level."""
        self._emit(logging.INFO, "info", message, fields)

    def warning(self, message: str, **fields: object) -> None:
        """Log at warn level."""
        self._emit(logging.WARNING, "warn", message, fields)

    def error(self, message: str, **fields: object) -> None:
        """Log at error level."""
        self._emit(logging.ERROR, "error", message, fields)

    def exception(self, message: str, **fields: object) -> None:
        """Log at error level including the active exception's traceback."""
        self._emit(logging.ERROR, "error", message, fields)
