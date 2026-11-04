"""The OpenAPI schema and docs UIs must be gated by environment (audit #60)."""

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.pool import StaticPool

from keel_core.adapters.outbound.persistence import Database
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator
from reference_service.composition import build_app
from reference_service.config import ReferenceConfig

DOC_PATHS = ("/openapi.json", "/docs", "/redoc")


async def _client(environment: str) -> tuple[httpx.AsyncClient, Database]:
    database = Database("sqlite+aiosqlite://", poolclass=StaticPool)
    config = ReferenceConfig(database_url="sqlite+aiosqlite://", environment=environment)
    app = build_app(
        config,
        authenticator=StubAuthenticator(
            {"tok": Principal(subject="user-1", scopes=frozenset({"items:read"}))},
        ),
        database=database,
    )
    await database.create_all()
    transport = ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test"), database


@pytest.mark.parametrize("path", DOC_PATHS)
async def test_docs_served_in_dev(path: str) -> None:
    client, database = await _client("dev")
    try:
        assert (await client.get(path)).status_code == 200
    finally:
        await client.aclose()
        await database.dispose()


@pytest.mark.parametrize("path", DOC_PATHS)
async def test_docs_hidden_in_production(path: str) -> None:
    client, database = await _client("prod")
    try:
        # No schema, no doc UIs: the API map is not disclosed anonymously.
        assert (await client.get(path)).status_code == 404
    finally:
        await client.aclose()
        await database.dispose()
