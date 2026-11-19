"""Unit tests for AwsSecretsManagerSecretProvider using the botocore Stubber (ADR-0024).

No network: a botocore ``Stubber`` queues ``GetSecretValue`` responses and modeled client
errors on a real boto3 client, so we assert the field map round-trips, the ADR-0023
coercion, not-found-as-empty, the SecretBinary / non-object fail-closed paths, the no-leak
invariant on a refresh failure, and the fail-closed backend selection.
"""

from __future__ import annotations

import json
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber

from keel_core.adapters.outbound.secrets import (
    AwsSecretsManagerSecretProvider,
    EnvSecretProvider,
    OpenBaoSecretProvider,
    secret_provider_from_env,
)
from keel_core.adapters.outbound.secrets.aws import _build_client

_SECRET_ID = "keel-test"
_ACCESS_KEY_CANARY = "AKIA-leak-canary-access-key"
_ARN = f"arn:aws:secretsmanager:us-east-1:000000000000:secret:{_SECRET_ID}"


def _client() -> Any:
    # Static dummy creds keep boto3 from touching the credential chain / network.
    return boto3.client(
        "secretsmanager",
        region_name="us-east-1",
        aws_access_key_id=_ACCESS_KEY_CANARY,
        aws_secret_access_key="secret-leak-canary-key",
    )


def _ok_response(fields: dict[str, Any]) -> dict[str, Any]:
    return {
        "ARN": _ARN,
        "Name": _SECRET_ID,
        "SecretString": json.dumps(fields),
    }


def test_field_map_roundtrips() -> None:
    client = _client()
    stubber = Stubber(client)
    stubber.add_response(
        "get_secret_value",
        _ok_response({"db_password": "s3cret", "api_key": "abc"}),
        {"SecretId": _SECRET_ID},
    )
    stubber.activate()
    with AwsSecretsManagerSecretProvider(
        secret_id=_SECRET_ID, client=client, start_refresh=False
    ) as provider:
        assert provider.get("db_password") == "s3cret"
        assert provider.get_optional("api_key") == "abc"
        assert provider.get_optional("missing") is None
        with pytest.raises(KeyError):
            provider.get("missing")


def test_field_coercion_is_canonical_not_python_repr() -> None:
    client = _client()
    stubber = Stubber(client)
    stubber.add_response(
        "get_secret_value",
        _ok_response(
            {
                "name": "alice",
                "flag_true": True,
                "flag_false": False,
                "count": 3,
                "ratio": 3.5,
                "obj": {"a": 1},
                "arr": [1, 2],
                "nothing": None,
            }
        ),
        {"SecretId": _SECRET_ID},
    )
    stubber.activate()
    with AwsSecretsManagerSecretProvider(
        secret_id=_SECRET_ID, client=client, start_refresh=False
    ) as provider:
        assert provider.get("name") == "alice"
        assert provider.get("count") == "3"
        assert provider.get("ratio") == "3.5"
        assert provider.get("flag_true") == "true"  # not Python "True"
        assert provider.get("flag_false") == "false"
        for absent in ("obj", "arr", "nothing"):  # object/array/null are not scalar secrets
            assert provider.get_optional(absent) is None


def test_resource_not_found_is_empty_map() -> None:
    client = _client()
    stubber = Stubber(client)
    stubber.add_client_error(
        "get_secret_value",
        service_error_code="ResourceNotFoundException",
        http_status_code=400,
    )
    stubber.activate()
    with AwsSecretsManagerSecretProvider(
        secret_id=_SECRET_ID, client=client, start_refresh=False
    ) as provider:
        assert provider.get_optional("anything") is None
        with pytest.raises(KeyError):
            provider.get("anything")


def test_secret_binary_only_fails_closed() -> None:
    client = _client()
    stubber = Stubber(client)
    stubber.add_response(
        "get_secret_value",
        {"ARN": _ARN, "Name": _SECRET_ID, "SecretBinary": b"\x00\x01binary"},
        {"SecretId": _SECRET_ID},
    )
    stubber.activate()
    with pytest.raises(ValueError, match="SecretBinary is unsupported"):
        AwsSecretsManagerSecretProvider(secret_id=_SECRET_ID, client=client, start_refresh=False)


def test_non_object_json_fails_closed() -> None:
    client = _client()
    stubber = Stubber(client)
    stubber.add_response(
        "get_secret_value",
        {"ARN": _ARN, "Name": _SECRET_ID, "SecretString": json.dumps([1, 2, 3])},
        {"SecretId": _SECRET_ID},
    )
    stubber.activate()
    with pytest.raises(ValueError, match="not a JSON object of fields"):
        AwsSecretsManagerSecretProvider(secret_id=_SECRET_ID, client=client, start_refresh=False)


def test_malformed_json_fails_closed_without_leaking_payload() -> None:
    leak = "SECRET-LEAK-in-malformed-payload"
    client = _client()
    stubber = Stubber(client)
    stubber.add_response(
        "get_secret_value",
        {"ARN": _ARN, "Name": _SECRET_ID, "SecretString": f"not-json {leak}"},
        {"SecretId": _SECRET_ID},
    )
    stubber.activate()
    with pytest.raises(ValueError) as exc_info:  # noqa: PT011 - message asserted below
        AwsSecretsManagerSecretProvider(secret_id=_SECRET_ID, client=client, start_refresh=False)
    exc = exc_info.value
    assert "is not valid JSON" in str(exc)
    assert leak not in str(exc)  # the payload is never echoed
    # The JSONDecodeError (whose .doc holds the payload) is not chained as the cause.
    assert exc.__cause__ is None


def test_empty_secret_id_rejected() -> None:
    with pytest.raises(ValueError, match="KEEL_AWS_SECRET_ID must be set"):
        AwsSecretsManagerSecretProvider(secret_id="", client=_client(), start_refresh=False)


# -- bounded client timeouts/retries (ADR-0023 hard-HTTP-timeout rule) -------------


def test_build_client_applies_bounded_timeouts_and_retry_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The production boto3 client caps connect/read timeouts and retry attempts.

    Without an explicit ``botocore.config.Config`` the client inherits boto3's 60s/60s/
    ~5-attempt defaults, so a wedged Secrets Manager stalls the eager startup load for
    minutes. Capture the ``config`` passed to ``boto3.client`` and assert the bound so it
    cannot silently regress.
    """
    captured: dict[str, Any] = {}

    def _spy_client(service_name: str, **kwargs: Any) -> object:
        captured["service_name"] = service_name
        captured["config"] = kwargs.get("config")
        captured["region_name"] = kwargs.get("region_name")
        return object()  # no network: construction only inspects the passed config

    monkeypatch.setattr(boto3, "client", _spy_client)

    _build_client("us-east-1")

    assert captured["service_name"] == "secretsmanager"
    assert captured["region_name"] == "us-east-1"
    config = captured["config"]
    assert config is not None
    assert config.connect_timeout == 5
    assert config.read_timeout == 10
    assert config.retries == {"max_attempts": 2, "mode": "standard"}


# -- no-leak invariant (ADR-0023/0024) --------------------------------------------


class _RecordingLogger:
    """A Logger that captures every emitted message and its structured fields as text."""

    def __init__(self) -> None:
        self.records: list[str] = []

    def _record(self, message: str, **fields: object) -> None:
        self.records.append(f"{message} {json.dumps(fields, default=str)}")

    def debug(self, message: str, **fields: object) -> None:
        self._record(message, **fields)

    def info(self, message: str, **fields: object) -> None:
        self._record(message, **fields)

    def warning(self, message: str, **fields: object) -> None:
        self._record(message, **fields)

    def error(self, message: str, **fields: object) -> None:
        self._record(message, **fields)

    def exception(self, message: str, **fields: object) -> None:
        self._record(message, **fields)

    @property
    def text(self) -> str:
        return "\n".join(self.records)


def test_refresh_failure_does_not_leak_secret_or_credential() -> None:
    secret_value = "s3cret-leak-canary-value"
    client = _client()
    stubber = Stubber(client)
    # Good first load, then a failing refresh (permission denied).
    stubber.add_response(
        "get_secret_value",
        _ok_response({"db_password": secret_value}),
        {"SecretId": _SECRET_ID},
    )
    stubber.add_client_error(
        "get_secret_value",
        service_error_code="AccessDeniedException",
        service_message="is not authorized to perform secretsmanager:GetSecretValue",
        http_status_code=400,
    )
    stubber.activate()
    logger = _RecordingLogger()
    with AwsSecretsManagerSecretProvider(
        secret_id=_SECRET_ID, client=client, logger=logger, start_refresh=False
    ) as provider:
        provider._refresh_once()  # noqa: SLF001 - exercising the refresh path directly
        assert provider.get("db_password") == secret_value  # last good map still served
    captured = logger.text
    assert logger.records  # the failure was actually logged
    assert secret_value not in captured
    assert _ACCESS_KEY_CANARY not in captured


# -- fail-closed backend selection (ADR-0024) -------------------------------------


def test_selection_rejects_multiple_backends() -> None:
    with pytest.raises(ValueError, match="multiple secret backends configured"):
        secret_provider_from_env(
            environ={
                "KEEL_VAULT_ADDR": "http://127.0.0.1:8200",
                "KEEL_AWS_SECRET_ID": _SECRET_ID,
            }
        )


def test_selection_defaults_to_env_when_unset() -> None:
    provider = secret_provider_from_env(environ={"KEEL_SECRET_X": "y"})
    assert isinstance(provider, EnvSecretProvider)
    assert provider.get("x") == "y"


def test_selection_ignores_whitespace_only_gating_vars() -> None:
    provider = secret_provider_from_env(
        environ={"KEEL_VAULT_ADDR": "   ", "KEEL_AWS_SECRET_ID": "\t", "KEEL_SECRET_Z": "z"}
    )
    assert isinstance(provider, EnvSecretProvider)


def test_factory_builds_aws_when_secret_id_set(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    stubber = Stubber(client)
    stubber.add_response(
        "get_secret_value",
        _ok_response({"db_password": "pw"}),
        {"SecretId": _SECRET_ID},
    )
    stubber.activate()
    monkeypatch.setattr(
        "keel_core.adapters.outbound.secrets.aws._build_client", lambda _region: client
    )
    provider = secret_provider_from_env(
        environ={
            "KEEL_AWS_SECRET_ID": _SECRET_ID,
            "KEEL_AWS_REGION": "us-east-1",
            "KEEL_SECRET_CACHE_TTL_SECONDS": "3600",  # long TTL: thread parks, no refresh in-test
        }
    )
    assert isinstance(provider, AwsSecretsManagerSecretProvider)
    assert not isinstance(provider, OpenBaoSecretProvider)
    assert provider.get("db_password") == "pw"
    provider.close()
