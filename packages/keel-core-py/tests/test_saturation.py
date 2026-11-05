"""Saturation signals: DB pool gauge and dropped-log counter (audit #67)."""

from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from keel_core.adapters.outbound.persistence import Database
from keel_core.adapters.outbound.telemetry import observe_db_pool, observe_log_drops


def _collect(reader: InMemoryMetricReader) -> dict[str, object]:
    data = reader.get_metrics_data()
    names: dict[str, object] = {}
    if data is None:
        return names
    for resource_metric in data.resource_metrics:
        for scope_metric in resource_metric.scope_metrics:
            for metric in scope_metric.metrics:
                names[metric.name] = metric
    return names


def _local_meter() -> tuple[MeterProvider, InMemoryMetricReader]:
    # A local provider avoids the process-global set-once MeterProvider.
    reader = InMemoryMetricReader()
    return MeterProvider(metric_readers=[reader]), reader


def test_pool_stats_shape() -> None:
    db = Database("sqlite+aiosqlite://")
    stats = db.pool_stats()
    assert set(stats) == {"used", "idle", "max"}
    assert all(isinstance(v, int) and v >= 0 for v in stats.values())


def test_db_pool_gauge_is_registered_with_semconv_states() -> None:
    provider, reader = _local_meter()
    observe_db_pool(Database("sqlite+aiosqlite://"), meter=provider.get_meter("test"))
    metrics = _collect(reader)
    count = metrics["db.client.connection.count"]  # semconv metric name
    states = {
        p.attributes["db.client.connection.state"]  # type: ignore[attr-defined]
        for p in count.data.data_points  # type: ignore[attr-defined]
    }
    assert states == {"used", "idle"}  # OTel DB semconv enum
    # Every point carries the pool name so multi-pool services do not collapse.
    assert all(
        "db.client.connection.pool.name" in p.attributes  # type: ignore[attr-defined]
        for p in count.data.data_points  # type: ignore[attr-defined]
    )
    # The saturation denominator is emitted as its own gauge.
    assert "db.client.connection.max" in metrics


def test_log_drops_counter_reports_the_drop_count() -> None:
    provider, reader = _local_meter()

    class _Writer:
        dropped = 7

    observe_log_drops(_Writer(), meter=provider.get_meter("test"))  # type: ignore[arg-type]
    metric = _collect(reader).get("log.records.dropped")
    assert metric is not None
    points = list(metric.data.data_points)  # type: ignore[attr-defined]
    assert points[0].value == 7
