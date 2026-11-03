import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.pool import StaticPool

from keel_core.adapters.outbound.persistence import Database
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator
from reference_service.composition import build_app
from reference_service.config import ReferenceConfig

_AUTH = {"authorization": "Bearer tok"}


@pytest.fixture
async def client():
    database = Database("sqlite+aiosqlite://", poolclass=StaticPool)
    config = ReferenceConfig(database_url="sqlite+aiosqlite://")
    app = build_app(
        config,
        authenticator=StubAuthenticator({"tok": Principal(subject="user-1")}),
        database=database,
    )
    await database.create_all()
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as async_client:
        yield async_client
    await database.dispose()


async def test_create_requires_authentication(client):
    response = await client.post("/items", json={"name": "widget"})
    assert response.status_code == 401
    assert response.json()["type"] == "urn:keel:error:unauthenticated"


async def test_create_then_fetch(client):
    created = await client.post("/items", json={"name": "widget"}, headers=_AUTH)
    assert created.status_code == 201
    item_id = created.json()["id"]

    fetched = await client.get(f"/items/{item_id}", headers=_AUTH)
    assert fetched.status_code == 200
    assert fetched.json() == {"id": item_id, "name": "widget"}


async def test_list_items(client):
    await client.post("/items", json={"name": "a"}, headers=_AUTH)
    await client.post("/items", json={"name": "b"}, headers=_AUTH)
    listed = await client.get("/items", headers=_AUTH)
    assert listed.status_code == 200
    assert {item["name"] for item in listed.json()} == {"a", "b"}


async def test_missing_item_is_problem_json_404(client):
    response = await client.get("/items/does-not-exist", headers=_AUTH)
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "urn:keel:error:not_found"


async def test_health_is_live(client):
    assert (await client.get("/healthz")).status_code == 200
