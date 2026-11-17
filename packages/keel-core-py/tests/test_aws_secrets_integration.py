"""AwsSecretsManagerSecretProvider against a real Secrets Manager (LocalStack) (ADR-0024).

Runs only when KEEL_AWS_SECRET_ID is set (CI starts a LocalStack secretsmanager
container; boto3 routes there via AWS_ENDPOINT_URL_SECRETS_MANAGER); skipped otherwise.
Creates a JSON secret with boto3, then reads it back through the adapter to prove
end-to-end behavior against a real Secrets Manager endpoint.
"""

from __future__ import annotations

import json
import os

import boto3
import pytest

from keel_core.adapters.outbound.secrets import AwsSecretsManagerSecretProvider

_SECRET_ID = os.environ.get("KEEL_AWS_SECRET_ID")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(_SECRET_ID is None, reason="KEEL_AWS_SECRET_ID not set"),
]


def _put_secret(fields: dict[str, str]) -> None:
    client = boto3.client("secretsmanager")
    payload = json.dumps(fields)
    try:
        client.create_secret(Name=_SECRET_ID, SecretString=payload)
    except client.exceptions.ResourceExistsException:
        client.put_secret_value(SecretId=_SECRET_ID, SecretString=payload)


def test_roundtrips_a_real_secretsmanager_secret() -> None:
    assert _SECRET_ID is not None
    _put_secret({"db_password": "integration-pw", "api_key": "k-123"})
    with AwsSecretsManagerSecretProvider(secret_id=_SECRET_ID, start_refresh=False) as provider:
        assert provider.get("db_password") == "integration-pw"
        assert provider.get("api_key") == "k-123"
        assert provider.get_optional("nope") is None
