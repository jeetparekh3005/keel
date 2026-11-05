import pytest
from fastapi import Depends

from keel_core.adapters.inbound.http import (
    assert_routes_require_auth,
    create_app,
    require_scopes,
    unprotected_routes,
)
from keel_core.testkit.fakes import StubAuthenticator


def _app():
    return create_app(service="t", version="0", authenticator=StubAuthenticator({}))


def test_health_routes_are_exempt_and_pass():
    assert_routes_require_auth(_app())  # only health routes -> no violation


def test_unprotected_route_is_detected():
    app = _app()

    @app.get("/open")
    async def open_route():
        return {}

    assert "GET /open" in unprotected_routes(app)
    with pytest.raises(RuntimeError, match="deny-by-default"):
        assert_routes_require_auth(app)


def test_unprotected_websocket_route_is_detected():
    from fastapi import WebSocket

    app = _app()

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):  # pragma: no cover - never connected
        await websocket.accept()

    assert "WS /ws" in unprotected_routes(app)


def test_raw_non_exempt_route_is_flagged_unverified():
    from starlette.routing import Route

    app = _app()

    async def raw(request):  # pragma: no cover - never called
        return None

    # A raw Starlette route has no auth dependency to inspect, so it must not be
    # silently allowed: it is reported until explicitly exempted.
    app.router.routes.append(Route("/raw", raw))
    assert any("UNVERIFIED /raw" in m for m in unprotected_routes(app))


def test_protected_route_passes():
    app = _app()

    @app.get("/closed", dependencies=[Depends(require_scopes("x:read"))])
    async def closed_route():
        return {}

    assert unprotected_routes(app) == []
    assert_routes_require_auth(app)
