"""Request-scoped context propagated into logs and telemetry.

Inbound adapters set these; the structured logger reads them so every log line
carries correlation ids without threading them through call signatures.
"""

from __future__ import annotations

from contextvars import ContextVar

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)
span_id_var: ContextVar[str | None] = ContextVar("span_id", default=None)
