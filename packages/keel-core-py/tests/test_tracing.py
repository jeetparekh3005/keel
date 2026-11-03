import json

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from keel_core.adapters.inbound.http import create_app
from keel_core.adapters.outbound.telemetry import configure_tracing
from keel_core.testkit.fakes import StubAuthenticator, capturing_logger

# set_tracer_provider can only be set once per process; configure globally.
_EXPORTER = InMemorySpanExporter()
configure_tracing(service="t", version="0", exporter=_EXPORTER)


@pytest.fixture(autouse=True)
def _clear_spans():
    _EXPORTER.clear()


def _server_span():
    for span in _EXPORTER.get_finished_spans():
        if span.name == "GET /ping":
            return span
    return None


def test_fastapi_emits_a_server_span():
    app = create_app(service="t", version="0", authenticator=StubAuthenticator({}))

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    TestClient(app).get("/ping")
    assert _server_span() is not None


def test_inbound_traceparent_is_continued():
    app = create_app(service="t", version="0", authenticator=StubAuthenticator({}))

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    trace_id = "0af7651916cd43dd8448eb211c80319c"
    traceparent = f"00-{trace_id}-b7ad6b7169203331-01"
    TestClient(app).get("/ping", headers={"traceparent": traceparent})
    assert format(_server_span().context.trace_id, "032x") == trace_id


def test_logs_during_a_request_carry_the_trace_id():
    logger, buffer = capturing_logger(service="t", version="0")
    app = create_app(service="t", version="0", authenticator=StubAuthenticator({}))

    @app.get("/ping")
    async def ping():
        logger.info("handling request")
        return {"ok": True}

    TestClient(app).get("/ping")
    record = json.loads(buffer.getvalue().splitlines()[-1])
    assert record["trace_id"] == format(_server_span().context.trace_id, "032x")
