"""Structured logging on structlog (platform.yaml logging contract).

Enterprise-grade: real exception tracebacks, recursive secret redaction with
value-pattern scrubbing, reserved-field protection, field-size caps, optional
rate limiting, correlation ids from :mod:`keel_core.context`, a non-blocking
background writer, and a stdlib bridge so third-party library logs
(uvicorn, SQLAlchemy, httpx, ...) come out in the same JSON schema.

Output is JSON lines to a stream (stdout by default); shipping to a backend is
the collector's job (12-factor), not the service's.
"""

from __future__ import annotations

import contextlib
import logging
import queue
import sys
import threading
import time
from collections.abc import Callable
from typing import Protocol, TextIO, cast

import structlog
from opentelemetry import trace as otel_trace
from structlog.types import EventDict, Processor, WrappedLogger

from keel_core import context
from keel_core.adapters.outbound.redaction import DEFAULT_MAX_FIELD_LEN, sanitize


class _TextSink(Protocol):
    """Minimal text stream: anything the logger can write JSON lines to."""

    def write(self, s: str, /) -> int:
        """Write ``s`` and return the number of characters written."""
        ...

    def flush(self) -> None:
        """Flush buffered output."""
        ...


# Keys the logger owns; a user field with one of these names is namespaced
# (prefixed ``x_``) so it can never clobber the canonical value.
_RESERVED: frozenset[str] = frozenset(
    {"timestamp", "level", "message", "service", "version", "trace_id", "span_id", "exception"},
)

_LEVEL_ALIASES = {"warning": "warn", "critical": "fatal"}
_NEVER_RATE_LIMIT = frozenset({"error", "fatal"})


def _namespace_user_reserved(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    for key in list(event_dict):
        if key in _RESERVED:
            event_dict[f"x_{key}"] = event_dict.pop(key)
    return event_dict


def _add_correlation(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    # Prefer the live OpenTelemetry span (set by FastAPI/clients); fall back to
    # the contextvars for non-HTTP paths or when tracing is unconfigured.
    span_context = otel_trace.get_current_span().get_span_context()
    if span_context.is_valid:
        event_dict["trace_id"] = format(span_context.trace_id, "032x")
        event_dict["span_id"] = format(span_context.span_id, "016x")
    else:
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


class RateLimiter:
    """Token-bucket log rate limiter keyed by message. Never limits error/fatal.

    Suppressed counts are attached to the next admitted event of the same key as
    ``rate_limited_dropped`` so nothing is silently lost.
    """

    def __init__(
        self,
        *,
        capacity: int,
        refill_per_sec: float,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        """Create a limiter admitting ``capacity`` events, refilling ``refill_per_sec``."""
        self._capacity = float(capacity)
        self._refill = refill_per_sec
        self._now = now
        self._buckets: dict[str, tuple[float, float]] = {}
        self._dropped: dict[str, int] = {}
        self._lock = threading.Lock()

    def __call__(self, _: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
        """Admit or drop the event; attach a suppressed count when admitting again."""
        if event_dict.get("level") in _NEVER_RATE_LIMIT:
            return event_dict
        key = str(event_dict.get("event", ""))
        with self._lock:
            now = self._now()
            tokens, last = self._buckets.get(key, (self._capacity, now))
            tokens = min(self._capacity, tokens + (now - last) * self._refill)
            if tokens >= 1:
                dropped = self._dropped.pop(key, 0)
                self._buckets[key] = (tokens - 1, now)
                if dropped:
                    event_dict["rate_limited_dropped"] = dropped
                return event_dict
            self._buckets[key] = (tokens, now)
            self._dropped[key] = self._dropped.get(key, 0) + 1
            raise structlog.DropEvent


def _level_to_int(level: str) -> int:
    return logging.getLevelNamesMapping().get(level.upper(), logging.INFO)


def _shared_processors(
    service: str,
    version: str,
    *,
    max_field_len: int,
    rate_limiter: RateLimiter | None,
) -> list[Processor]:
    """Processor chain shared by the app logger and the stdlib bridge (no renderer)."""

    def _add_service_version(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
        event_dict["service"] = service
        event_dict["version"] = version
        return event_dict

    def _sanitize_processor(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
        result = sanitize(dict(event_dict), max_field_len)
        assert isinstance(result, dict)  # noqa: S101  # sanitize preserves dict type
        return cast("EventDict", result)

    chain: list[Processor] = [
        _namespace_user_reserved,
        _add_correlation,
        _add_service_version,
        structlog.processors.add_log_level,
        _normalize_level,
    ]
    if rate_limiter is not None:
        chain.append(rate_limiter)
    chain += [
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
        structlog.processors.format_exc_info,
        _sanitize_processor,
        structlog.processors.EventRenamer("message"),
    ]
    return chain


class QueueLogWriter:
    """Non-blocking file-like writer: enqueues text, a daemon thread writes it.

    Keeps logging off the hot path / event loop. The queue is bounded; on
    overflow, writes are dropped and counted (available as :attr:`dropped`)
    rather than blocking the caller.
    """

    def __init__(self, target: _TextSink, *, max_queue: int = 10000) -> None:
        """Wrap ``target``, starting a background writer thread."""
        self._target = target
        self._queue: queue.Queue[str | None] = queue.Queue(maxsize=max_queue)
        self.dropped = 0
        self.write_errors = 0
        self._thread = threading.Thread(target=self._run, name="keel-log-writer", daemon=True)
        self._thread.start()

    def write(self, text: str) -> int:
        """Enqueue ``text`` for the background writer (non-blocking)."""
        try:
            self._queue.put_nowait(text)
        except queue.Full:
            self.dropped += 1
        return len(text)

    def flush(self) -> None:
        """No-op; the background thread flushes the target after each write."""

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            try:
                self._target.write(item)
                self._target.flush()
            except Exception:
                # A sink failure (e.g. a closed stdout pipe, EPIPE, disk full) must
                # not kill the writer thread: if it died, the queue would fill and
                # every subsequent log would drop, and stop() could block forever on
                # a full queue. Count the error and keep draining.
                self.write_errors += 1

    def stop(self, *, timeout: float = 2.0) -> None:
        """Drain the queue and stop the writer thread. Call at service shutdown.

        Uses a bounded put so a wedged/full queue cannot make shutdown hang.
        """
        with contextlib.suppress(queue.Full):
            self._queue.put(None, timeout=timeout)
        self._thread.join(timeout=timeout)


class StructuredLogger:
    """Logger port adapter backed by structlog, emitting the contract JSON schema."""

    def __init__(
        self,
        *,
        service: str,
        version: str,
        level: str = "info",
        stream: _TextSink | None = None,
        max_field_len: int = DEFAULT_MAX_FIELD_LEN,
        rate_limiter: RateLimiter | None = None,
    ) -> None:
        """Create a logger bound to a service name, version, and minimum level."""
        self._log = structlog.wrap_logger(
            structlog.WriteLogger(
                file=cast("TextIO", stream if stream is not None else sys.stdout),
            ),
            processors=[
                *_shared_processors(
                    service,
                    version,
                    max_field_len=max_field_len,
                    rate_limiter=rate_limiter,
                ),
                structlog.processors.JSONRenderer(),
            ],
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
    stream: _TextSink | None = None,
    max_field_len: int = DEFAULT_MAX_FIELD_LEN,
    rate_limiter: RateLimiter | None = None,
    non_blocking: bool = True,
) -> QueueLogWriter | None:
    """Route stdlib logging (and thus third-party libraries) through the contract schema.

    Installs a single root handler whose formatter renders foreign log records with
    the same processor chain, so uvicorn/SQLAlchemy/httpx logs become correlated JSON.
    Call once at service startup. When ``non_blocking`` is true, returns the
    :class:`QueueLogWriter` so the caller can ``stop()`` it at shutdown.
    """
    target: _TextSink = stream if stream is not None else sys.stdout
    writer: QueueLogWriter | None = QueueLogWriter(target) if non_blocking else None
    sink: _TextSink = writer if writer is not None else target

    shared = _shared_processors(
        service, version, max_field_len=max_field_len, rate_limiter=rate_limiter
    )
    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
        foreign_pre_chain=shared,
    )
    handler = logging.StreamHandler(cast("TextIO", sink))
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(_level_to_int(level))
    return writer
