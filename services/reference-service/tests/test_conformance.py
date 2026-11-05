"""Behavioral contract-conformance suite for the composed reference service (#158).

Each test maps a platform.yaml claim to an assertion against the fully wired app,
run with the service's default-ish config - so an over-claim or a broken wiring
fails here, not just in a unit test. The per-signal claims (tracing + log
correlation, metrics semconv, pool saturation, log schema + redaction) are covered
by the keel-core suites (test_tracing, test_metrics, test_saturation, test_logging);
this suite covers the HTTP surface of the composed service.
"""

from keel_core.adapters.inbound.http import assert_routes_require_auth
from keel_core.testkit.contract import (
    assert_denies_anonymous,
    assert_liveness_ok,
    assert_no_cors_by_default,
    assert_problem_response,
    assert_readiness_present,
    assert_security_headers,
)
from keel_core.testkit.fakes import StubAuthenticator
from reference_service.composition import build_app
from reference_service.config import ReferenceConfig

_AUTH = {"authorization": "Bearer tok"}


def test_all_business_routes_require_auth():
    # platform.yaml auth.access_control: deny-by-default, enforced at startup.
    app = build_app(ReferenceConfig(), authenticator=StubAuthenticator({}))
    assert_routes_require_auth(app)  # raises if any non-exempt route is unprotected


async def test_conforms_liveness(client):
    # platform.yaml health.liveness: /healthz.
    await assert_liveness_ok(client)


async def test_conforms_readiness(client):
    # platform.yaml health.readiness: /readyz.
    await assert_readiness_present(client)


async def test_conforms_error_is_problem_json(client):
    # platform.yaml errors.standard: rfc9457 problem+json.
    response = await client.get("/v1/items/missing", headers=_AUTH)
    assert_problem_response(response, status=404)


async def test_protected_routes_deny_anonymous(client):
    # platform.yaml auth: non-exempt routes refuse an unauthenticated caller (401).
    await assert_denies_anonymous(client, "/v1/items/anything")
    await assert_denies_anonymous(client, "/v1/items")


async def test_responses_carry_security_headers(client):
    # platform.yaml http.security_headers: always emitted by keel-core.
    assert_security_headers(await client.get("/healthz"))


async def test_cors_is_deny_by_default(client):
    # platform.yaml http.cors.policy: deny-by-default (no origins configured here).
    assert_no_cors_by_default(await client.get("/healthz"))
