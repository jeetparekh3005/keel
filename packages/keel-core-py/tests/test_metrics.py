from fastapi.testclient import TestClient
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from keel_core.adapters.inbound.http import create_app
from keel_core.adapters.outbound.telemetry import configure_metrics
from keel_core.testkit.fakes import StubAuthenticator

# set_meter_provider can only be set once per process; configure globally.
_READER = InMemoryMetricReader()
configure_metrics(service="t", version="0", reader=_READER)


def _metrics_by_name():
    data = _READER.get_metrics_data()
    out = {}
    if data is None:
        return out
    for resource_metric in data.resource_metrics:
        for scope_metric in resource_metric.scope_metrics:
            for metric in scope_metric.metrics:
                out[metric.name] = metric
    return out


def test_http_request_metrics_are_recorded():
    app = create_app(service="t", version="0", authenticator=StubAuthenticator({}))
    TestClient(app).get("/healthz")
    metrics = _metrics_by_name()
    # Stable OTel HTTP semconv: a duration histogram (its count is the request volume).
    assert "http.server.request.duration" in metrics
    assert "http.server.requests" not in metrics
    assert "http.server.duration" not in metrics


def test_duration_carries_semconv_attributes_with_bounded_cardinality():
    app = create_app(service="t", version="0", authenticator=StubAuthenticator({}))
    TestClient(app).get("/healthz")
    metric = _metrics_by_name()["http.server.request.duration"]
    # The global reader accumulates points from every test's app, so select the
    # point for THIS request by its route template rather than taking the first.
    points = [p for p in metric.data.data_points if p.attributes.get("http.route") == "/healthz"]
    assert points, "no data point recorded for the /healthz route"
    attrs = points[0].attributes
    # Semconv attribute names, and the route is the TEMPLATE (bounded cardinality).
    assert attrs["http.request.method"] == "GET"
    assert attrs["http.response.status_code"] == 200
