"""Structured logging on structlog (platform.yaml logging contract).

Built on structlog so logs are enterprise-grade: real exception tracebacks,
recursive secret redaction, reserved-field protection, correlation ids from
:mod:`keel_core.context`, and a stdlib bridge so third-party library logs
(uvicorn, SQLAlchemy, httpx, ...) come out in the same JSON schema.

Output is JSON lines to a stream (stdout by default); shipping to a backend is
the collector's job (12-factor), not the service's.
"""

from __future__ import annotations

import logging
import sys
from typing import IO, TextIO, cast

import structlog
from structlog.types import EventDict, Processor, WrappedLogger

from keel_core import context

_REDACT_KEYS: frozenset[str] = frozenset(
    {"password", "token", "secret", "authorization", "set-cookie", "api_key", "pii"},
)
_REDACTED = "[REDACTED]"

# Keys the logger owns; a user field with one of these names is namespaced
# (prefixed ``x_``) so it can never clobber the canonical value.
_RESERVED: frozenset[str] = frozenset(
    {"timestamp", "level", "message", "service", "version", "trace_id", "span_id", "exception"},
)

_LEVEL_ALIASES = {"warning": "warn", "critical": "fatal"}


def _namespace_user_reserved(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    for key in list(event_dict):
        if key in _RESERVED:
            event_dict[f"x_{key}"] = event_dict.pop(key)
    return event_dict


def _add_correlation(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    event_dict["trace_id"] = context.trace_id_var.get()
    event_dict["span_id"] = context.span_id_var.get()
    request_id = context.request_id_var.get()
    if request_id is not None:
        event_dict["request_id"] = request_id
    return event_dict


def _normalize_level(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    level = event_dict.get("level")
    if isinstance(level, str) and level in _LEVEL_ALIASES:
        event_dict["level"] = _LEVEL_ALIASES[level]
    return event_dict


def _redact_value(value: object) -> object:
    if isinstance(value, dict):
        return {
            k: (_REDACTED if isinstance(k, str) and k.lower() in _REDACT_KEYS else _redact_value(v))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_redact_value(v) for v in value]
    return value


def _redact(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    redacted = _redact_value(dict(event_dict))
    assert isinstance(redacted, dict)  # noqa: S101  # _redact_value preserves dict type
    return redacted


def _level_to_int(level: str) -> int:
    return logging.getLevelNamesMapping().get(level.upper(), logging.INFO)


def _shared_processors(service: str, version: str) -> list[Processor]:
    """Processor chain shared by the app logger and the stdlib bridge (no renderer)."""

    def _add_service_version(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
        event_dict["service"] = service
        event_dict["version"] = version
        return event_dict

    return [
        _namespace_user_reserved,
        _add_correlation,
        _add_service_version,
        structlog.processors.add_log_level,
        _normalize_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
        structlog.processors.format_exc_info,
        _redact,
        structlog.processors.EventRenamer("message"),
    ]


class StructuredLogger:
    """Logger port adapter backed by structlog, emitting the contract JSON schema."""

    def __init__(
        self,
        *,
        service: str,
        version: str,
        level: str = "info",
        stream: IO[str] | None = None,
    ) -> None:
        """Create a logger bound to a service name, version, and minimum level."""
        self._log = structlog.wrap_logger(
            structlog.WriteLogger(
                file=cast("TextIO", stream if stream is not None else sys.stdout)
            ),
            processors=[*_shared_processors(service, version), structlog.processors.JSONRenderer()],
            wrapper_class=structlog.make_filtering_bound_logger(_level_to_int(level)),
        )

    def debug(self, message: str, **fields: object) -> None:
        """Log at debug level."""
        self._log.debug(message, **fields)

    def info(self, message: str, **fields: object) -> None:
        """Log at info level."""
        self._log.info(message, **fields)

    def warning(self, message: str, **fields: object) -> None:
        """Log at warn level."""
        self._log.warning(message, **fields)

    def error(self, message: str, **fields: object) -> None:
        """Log at error level."""
        self._log.error(message, **fields)

    def exception(self, message: str, **fields: object) -> None:
        """Log at error level including the active exception's traceback."""
        self._log.error(message, exc_info=True, **fields)


def configure_logging(
    *,
    service: str,
    version: str,
    level: str = "info",
    stream: IO[str] | None = None,
) -> None:
    """Route stdlib logging (and thus third-party libraries) through the contract schema.

    Installs a single root handler whose formatter renders foreign log records with
    the same processor chain, so uvicorn/SQLAlchemy/httpx logs become correlated JSON.
    Call once at service startup.
    """
    shared = _shared_processors(service, version)
    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
        foreign_pre_chain=shared,
    )
    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(_level_to_int(level))
