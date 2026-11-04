from keel_core.adapters.inbound.http import assert_routes_require_auth
from keel_core.testkit.contract import (
    assert_liveness_ok,
    assert_problem_response,
    assert_readiness_present,
)
from keel_core.testkit.fakes import StubAuthenticator
from reference_service.composition import build_app
from reference_service.config import ReferenceConfig

_AUTH = {"authorization": "Bearer tok"}


def test_all_business_routes_require_auth():
    app = build_app(ReferenceConfig(), authenticator=StubAuthenticator({}))
    assert_routes_require_auth(app)  # raises if any non-exempt route is unprotected


async def test_conforms_liveness(client):
    await assert_liveness_ok(client)


async def test_conforms_readiness(client):
    await assert_readiness_present(client)


async def test_conforms_error_is_problem_json(client):
    response = await client.get("/v1/items/missing", headers=_AUTH)
    assert_problem_response(response, status=404)
