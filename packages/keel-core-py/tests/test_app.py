from fastapi import Depends
from fastapi.testclient import TestClient

from keel_core.adapters.inbound.http import create_app
from keel_core.domain.errors import NotFound
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator


def _build_app():
    app = create_app(
        service="t",
        version="0",
        authenticator=StubAuthenticator({"tok": Principal(subject="u")}),
    )

    @app.get("/boom")
    async def boom():
        raise NotFound("nope")

    @app.get("/kaboom")
    async def kaboom():
        raise RuntimeError("leak me")

    @app.get("/secure", dependencies=[Depends(app.state.require_principal)])
    async def secure():
        return {"ok": True}

    return app


def test_healthz_is_live():
    response = TestClient(_build_app()).get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_readyz_ready_by_default():
    assert TestClient(_build_app()).get("/readyz").status_code == 200


def test_readyz_503_when_a_check_fails():
    async def failing():
        return False

    app = create_app(
        service="t", version="0", authenticator=StubAuthenticator({}), readiness_checks=[failing]
    )
    assert TestClient(app).get("/readyz").status_code == 503


def test_domain_error_is_problem_json():
    response = TestClient(_build_app()).get("/boom")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 404
    assert body["title"] == "Not Found"
    assert body["type"] == "urn:keel:error:not_found"


def test_unhandled_error_is_500_without_leaking():
    client = TestClient(_build_app(), raise_server_exceptions=False)
    response = client.get("/kaboom")
    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "leak me" not in response.text


def test_request_id_is_minted_and_echoed():
    client = TestClient(_build_app())
    assert client.get("/healthz").headers.get("x-request-id")
    echoed = client.get("/healthz", headers={"x-request-id": "abc123"})
    assert echoed.headers["x-request-id"] == "abc123"


def test_protected_route_denies_without_credential():
    response = TestClient(_build_app()).get("/secure")
    assert response.status_code == 401
    assert response.json()["type"] == "urn:keel:error:unauthenticated"


def test_protected_route_allows_valid_bearer():
    response = TestClient(_build_app()).get("/secure", headers={"authorization": "Bearer tok"})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
