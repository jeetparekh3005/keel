"""Request-scoped context propagated into logs and telemetry.

Inbound adapters set these; the structured logger reads them so every log line
carries correlation ids without threading them through call signatures.
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from keel_core.ports.auth import Principal

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)
span_id_var: ContextVar[str | None] = ContextVar("span_id", default=None)
# The authenticated caller for the current RPC/request (set by inbound adapters).
principal_var: ContextVar[Principal | None] = ContextVar("principal", default=None)
