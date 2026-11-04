"""Saturation signals: the fourth golden signal (pool usage, dropped logs).

These are observable instruments: OpenTelemetry polls the callbacks at collection
time. Register them once at startup, after the meter provider is configured.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING

from opentelemetry.metrics import CallbackOptions, Meter, Observation

from keel_core.adapters.outbound.telemetry.metrics import get_meter

if TYPE_CHECKING:
    from keel_core.adapters.outbound.logging import QueueLogWriter
    from keel_core.adapters.outbound.persistence import Database


def observe_db_pool(
    database: Database,
    *,
    meter: Meter | None = None,
    meter_name: str = "keel.db",
) -> None:
    """Register an observable gauge of DB connection-pool usage by state."""

    def _callback(_: CallbackOptions) -> Iterable[Observation]:
        # OTel DB semconv state enum is {used, idle}; checkedout() already includes
        # any overflow connections that are in use.
        stats = database.pool_stats()
        return [
            Observation(stats["checked_out"], {"state": "used"}),
            Observation(stats["available"], {"state": "idle"}),
        ]

    (meter or get_meter(meter_name)).create_observable_gauge(
        "db.client.connections.usage",
        callbacks=[_callback],
        unit="{connection}",
        description="Database connection-pool usage by state.",
    )


def observe_log_drops(
    writer: QueueLogWriter,
    *,
    meter: Meter | None = None,
    meter_name: str = "keel.logging",
) -> None:
    """Register an observable counter of log records dropped under backpressure."""

    def _callback(_: CallbackOptions) -> Iterable[Observation]:
        return [Observation(writer.dropped)]

    (meter or get_meter(meter_name)).create_observable_counter(
        "log.records.dropped",
        callbacks=[_callback],
        unit="{record}",
        description="Log records dropped because the writer queue was full.",
    )
