from fastapi.testclient import TestClient
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from keel_core.adapters.inbound.http import create_app
from keel_core.adapters.outbound.telemetry import configure_metrics
from keel_core.testkit.fakes import StubAuthenticator

# set_meter_provider can only be set once per process; configure globally.
_READER = InMemoryMetricReader()
configure_metrics(service="t", version="0", reader=_READER)


def _metric_names():
    data = _READER.get_metrics_data()
    if data is None:
        return set()
    return {
        metric.name
        for resource_metric in data.resource_metrics
        for scope_metric in resource_metric.scope_metrics
        for metric in scope_metric.metrics
    }


def test_http_request_metrics_are_recorded():
    app = create_app(service="t", version="0", authenticator=StubAuthenticator({}))
    TestClient(app).get("/healthz")
    names = _metric_names()
    assert "http.server.requests" in names
    assert "http.server.duration" in names
