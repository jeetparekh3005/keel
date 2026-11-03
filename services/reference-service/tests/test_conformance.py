from keel_core.testkit.contract import (
    assert_liveness_ok,
    assert_problem_response,
    assert_readiness_present,
)

_AUTH = {"authorization": "Bearer tok"}


async def test_conforms_liveness(client):
    await assert_liveness_ok(client)


async def test_conforms_readiness(client):
    await assert_readiness_present(client)


async def test_conforms_error_is_problem_json(client):
    response = await client.get("/items/missing", headers=_AUTH)
    assert_problem_response(response, status=404)
