import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.pool import StaticPool

from keel_core.adapters.outbound.persistence import Database
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator
from reference_service.composition import build_app
from reference_service.config import ReferenceConfig


@pytest.fixture
async def client():
    database = Database("sqlite+aiosqlite://", poolclass=StaticPool)
    config = ReferenceConfig(database_url="sqlite+aiosqlite://")
    app = build_app(
        config,
        authenticator=StubAuthenticator(
            {
                "tok": Principal(subject="user-1", scopes=frozenset({"items:read", "items:write"})),
                "readonly": Principal(subject="user-2", scopes=frozenset({"items:read"})),
            },
        ),
        database=database,
    )
    await database.create_all()
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as async_client:
        yield async_client
    await database.dispose()
