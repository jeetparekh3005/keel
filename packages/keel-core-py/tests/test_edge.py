from fastapi import Request
from fastapi.testclient import TestClient

from keel_core.adapters.inbound.http import create_app
from keel_core.testkit.fakes import StubAuthenticator


def _app(max_request_bytes: int = 1_048_576):
    return create_app(
        service="t",
        version="0",
        authenticator=StubAuthenticator({}),
        max_request_bytes=max_request_bytes,
    )


def test_security_headers_present():
    response = TestClient(_app()).get("/healthz")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "strict-transport-security" in response.headers


def test_oversized_body_is_rejected_before_handling():
    client = TestClient(_app(max_request_bytes=16))
    response = client.post("/anything", content=b"x" * 100)
    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "urn:keel:error:payload_too_large"


def test_within_limit_body_passes_the_guard():
    # No such route -> 404, but importantly NOT 413 (the guard let it through).
    client = TestClient(_app(max_request_bytes=1024))
    response = client.post("/missing", content=b"small")
    assert response.status_code != 413


def test_streaming_body_without_content_length_is_capped():
    app = _app(max_request_bytes=16)

    @app.post("/echo")
    async def echo(request: Request):
        return {"len": len(await request.body())}

    def chunks():
        yield b"x" * 100  # no Content-Length -> chunked; guard counts as it streams

    response = TestClient(app).post("/echo", content=chunks())
    assert response.status_code == 413
