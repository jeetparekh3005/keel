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
    pool_name: str = "default",
) -> None:
    """Register observable gauges of DB connection-pool usage (OTel DB semconv).

    Emits ``db.client.connection.count`` by state ({used, idle}) and
    ``db.client.connection.max`` (the denominator), both tagged with
    ``db.client.connection.pool.name`` so a service with multiple pools does not
    collapse them into one series.
    """
    attrs = {"db.client.connection.pool.name": pool_name}

    def _count_callback(_: CallbackOptions) -> Iterable[Observation]:
        # semconv state enum {used, idle}; used = checked out (incl. in-use
        # overflow), idle = actually-warm checked-in connections.
        stats = database.pool_stats()
        return [
            Observation(stats["used"], {**attrs, "db.client.connection.state": "used"}),
            Observation(stats["idle"], {**attrs, "db.client.connection.state": "idle"}),
        ]

    def _max_callback(_: CallbackOptions) -> Iterable[Observation]:
        # The saturation denominator: base size + max overflow.
        return [Observation(database.pool_stats()["max"], dict(attrs))]

    resolved = meter or get_meter(meter_name)
    resolved.create_observable_gauge(
        "db.client.connection.count",
        callbacks=[_count_callback],
        unit="{connection}",
        description="Database connections by state.",
    )
    resolved.create_observable_gauge(
        "db.client.connection.max",
        callbacks=[_max_callback],
        unit="{connection}",
        description="Maximum open connections the pool allows (saturation denominator).",
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
