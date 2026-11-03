from fastapi.testclient import TestClient

from keel_core.adapters.inbound.http import create_app
from keel_core.testkit.fakes import StubAuthenticator


class _FakeDatabase:
    def __init__(self) -> None:
        self.disposed = False

    async def dispose(self) -> None:
        self.disposed = True


class _FakeWriter:
    def __init__(self) -> None:
        self.stopped = False

    def stop(self) -> None:
        self.stopped = True


class _FakeProvider:
    def __init__(self) -> None:
        self.shut_down = False

    def shutdown(self) -> None:
        self.shut_down = True


def test_lifespan_disposes_registered_resources():
    app = create_app(service="t", version="0", authenticator=StubAuthenticator({}))
    database, writer = _FakeDatabase(), _FakeWriter()
    tracer_provider, meter_provider = _FakeProvider(), _FakeProvider()
    app.state.database = database
    app.state.log_writer = writer
    app.state.tracer_provider = tracer_provider
    app.state.meter_provider = meter_provider

    with TestClient(app):  # context manager runs startup + shutdown (lifespan)
        pass

    assert database.disposed
    assert writer.stopped
    assert tracer_provider.shut_down
    assert meter_provider.shut_down


def test_lifespan_is_noop_without_resources():
    app = create_app(service="t", version="0", authenticator=StubAuthenticator({}))
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200
