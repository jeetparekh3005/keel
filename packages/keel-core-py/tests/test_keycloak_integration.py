"""OIDCAuthenticator against a real Keycloak (audit #34).

Runs only when KEEL_KEYCLOAK_URL is set (CI imports deploy/keycloak/realm.json
into a Keycloak container); skipped otherwise. Mints a real service-account
token via client_credentials and verifies it against the live JWKS.
"""

import os

import httpx
import pytest

from keel_core.adapters.outbound.auth import OIDCAuthenticator

_KC_URL = os.environ.get("KEEL_KEYCLOAK_URL")
_REALM = os.environ.get("KEEL_KEYCLOAK_REALM", "keel")
_CLIENT_ID = os.environ.get("KEEL_KEYCLOAK_CLIENT_ID", "keel-api")
_CLIENT_SECRET = os.environ.get("KEEL_KEYCLOAK_CLIENT_SECRET", "test-secret")
_AUDIENCE = os.environ.get("KEEL_OIDC_AUDIENCE", "keel-api")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(_KC_URL is None, reason="KEEL_KEYCLOAK_URL not set"),
]


def _realm_base() -> str:
    return f"{_KC_URL}/realms/{_REALM}"


async def test_authenticates_a_real_keycloak_token() -> None:
    token_url = f"{_realm_base()}/protocol/openid-connect/token"
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": _CLIENT_ID,
                "client_secret": _CLIENT_SECRET,
            },
        )
    resp.raise_for_status()
    token = resp.json()["access_token"]

    authenticator = OIDCAuthenticator.from_jwks(
        jwks_uri=f"{_realm_base()}/protocol/openid-connect/certs",
        issuer=_realm_base(),
        audience=_AUDIENCE,
        allow_insecure=True,  # local Keycloak is plaintext http in CI
    )
    principal = authenticator.authenticate(token)
    assert principal.subject  # service-account user id
