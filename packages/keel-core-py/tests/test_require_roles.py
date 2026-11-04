"""require_roles authorization primitive (audit #65: shipped untested)."""

import httpx
from fastapi import Depends
from httpx import ASGITransport

from keel_core.adapters.inbound.http import create_app, require_roles
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator


def _app() -> object:
    stub = StubAuthenticator(
        {
            "admin-tok": Principal(subject="u1", scopes=frozenset(), roles=frozenset({"admin"})),
            "user-tok": Principal(subject="u2", scopes=frozenset(), roles=frozenset({"viewer"})),
        },
    )
    app = create_app(service="t", version="0", authenticator=stub)

    @app.get("/admin", dependencies=[Depends(require_roles("admin"))])
    async def admin_route() -> dict[str, bool]:
        return {"ok": True}

    return app


async def _get(headers: dict[str, str]) -> httpx.Response:
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get("/admin", headers=headers)


async def test_require_roles_allows_matching_role() -> None:
    assert (await _get({"Authorization": "Bearer admin-tok"})).status_code == 200


async def test_require_roles_forbids_missing_role() -> None:
    assert (await _get({"Authorization": "Bearer user-tok"})).status_code == 403


async def test_require_roles_rejects_anonymous() -> None:
    assert (await _get({})).status_code == 401
