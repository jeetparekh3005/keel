"""TrustedHost enforcement (audit #127)."""

import httpx
from httpx import ASGITransport

from keel_core.adapters.inbound.http import create_app
from keel_core.testkit.fakes import StubAuthenticator


def _app() -> object:
    return create_app(
        service="t",
        version="0",
        authenticator=StubAuthenticator({}),
        trusted_hosts=["allowed.example"],
    )


async def test_allowed_host_is_accepted() -> None:
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://allowed.example") as client:
        assert (await client.get("/healthz")).status_code == 200


async def test_unknown_host_is_rejected() -> None:
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://evil.example") as client:
        assert (await client.get("/healthz")).status_code == 400
