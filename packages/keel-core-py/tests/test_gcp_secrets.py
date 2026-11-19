"""Unit tests for GcpSecretManagerSecretProvider with a mocked SDK client (ADR-0024).

No network and no ADC/metadata lookup: a ``unittest.mock`` stands in for the
``SecretManagerServiceClient`` (injected via the ``client`` seam, so the real
``google.auth`` default is never called). We assert the field map round-trips, the
ADR-0023 coercion, not-found-as-empty, the non-UTF-8 / non-object / malformed fail-closed
paths, the no-leak invariant on a refresh failure, the bounded request timeout/retry, and
the fail-closed backend selection.
"""

from __future__ import annotations

import json
import types
from typing import Any
from unittest import mock

import pytest
from google.api_core.exceptions import NotFound

from keel_core.adapters.outbound.secrets import (
    AwsSecretsManagerSecretProvider,
    EnvSecretProvider,
    GcpSecretManagerSecretProvider,
    OpenBaoSecretProvider,
    secret_provider_from_env,
)
from keel_core.adapters.outbound.secrets.gcp import (
    _REQUEST_TIMEOUT_SECONDS,
    _RETRY_TIMEOUT_SECONDS,
    _bounded_retry,
    _resource_name,
)

_SECRET = "projects/keel-test/secrets/app"
_VERSIONED = f"{_SECRET}/versions/7"
_CREDENTIAL_CANARY = "ya29.oauth-access-token-leak-canary"


def _response(payload: bytes) -> Any:
    """A minimal AccessSecretVersionResponse: only ``.payload.data`` is read."""
    return types.SimpleNamespace(payload=types.SimpleNamespace(data=payload))


def _json_response(fields: dict[str, Any]) -> Any:
    return _response(json.dumps(fields).encode("utf-8"))


def _mock_client(**configure: Any) -> Any:
    client = mock.Mock()
    client.access_secret_version.configure_mock(**configure)
    return client


# -- field map + coercion ----------------------------------------------------------


def test_field_map_roundtrips() -> None:
    client = _mock_client(return_value=_json_response({"db_password": "s3cret", "api_key": "abc"}))
    with GcpSecretManagerSecretProvider(
        secret=_SECRET, client=client, start_refresh=False
    ) as provider:
        assert provider.get("db_password") == "s3cret"
        assert provider.get_optional("api_key") == "abc"
        assert provider.get_optional("missing") is None
        with pytest.raises(KeyError):
            provider.get("missing")


def test_field_coercion_is_canonical_not_python_repr() -> None:
    client = _mock_client(
        return_value=_json_response(
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
        )
    )
    with GcpSecretManagerSecretProvider(
        secret=_SECRET, client=client, start_refresh=False
    ) as provider:
        assert provider.get("name") == "alice"
        assert provider.get("count") == "3"
        assert provider.get("ratio") == "3.5"
        assert provider.get("flag_true") == "true"  # not Python "True"
        assert provider.get("flag_false") == "false"
        for absent in ("obj", "arr", "nothing"):  # object/array/null are not scalar secrets
            assert provider.get_optional(absent) is None


# -- resource name resolution ------------------------------------------------------


def test_resource_name_appends_version_when_bare() -> None:
    assert _resource_name(_SECRET, "latest") == f"{_SECRET}/versions/latest"
    assert _resource_name(_SECRET, "7") == f"{_SECRET}/versions/7"


def test_resource_name_uses_full_version_verbatim() -> None:
    # A fully qualified .../versions/<v> is used as-is; the version arg is ignored.
    assert _resource_name(_VERSIONED, "latest") == _VERSIONED


def test_resource_name_trims_trailing_slash_before_appending_version() -> None:
    # A stray trailing slash on the bare resource name must not produce a malformed
    # double-slash name (parity with the Go and Rust adapters).
    assert _resource_name(f"{_SECRET}/", "latest") == f"{_SECRET}/versions/latest"
    assert _resource_name(f"{_SECRET}///", "7") == f"{_SECRET}/versions/7"


def test_accesses_the_requested_version() -> None:
    client = _mock_client(return_value=_json_response({"k": "v"}))
    with GcpSecretManagerSecretProvider(
        secret=_SECRET, version="7", client=client, start_refresh=False
    ):
        pass
    assert client.access_secret_version.call_args.kwargs["name"] == f"{_SECRET}/versions/7"


# -- not-found-as-empty ------------------------------------------------------------


def test_not_found_is_empty_map() -> None:
    client = _mock_client(side_effect=NotFound("secret version not found"))
    with GcpSecretManagerSecretProvider(
        secret=_SECRET, client=client, start_refresh=False
    ) as provider:
        assert provider.get_optional("anything") is None
        with pytest.raises(KeyError):
            provider.get("anything")


# -- fail-closed payloads ----------------------------------------------------------


def test_non_object_json_fails_closed() -> None:
    client = _mock_client(return_value=_json_response_list([1, 2, 3]))
    with pytest.raises(ValueError, match="not a JSON object of fields"):
        GcpSecretManagerSecretProvider(secret=_SECRET, client=client, start_refresh=False)


def _json_response_list(items: list[Any]) -> Any:
    return _response(json.dumps(items).encode("utf-8"))


def test_malformed_json_fails_closed_without_leaking_payload() -> None:
    leak = "SECRET-LEAK-in-malformed-payload"
    client = _mock_client(return_value=_response(f"not-json {leak}".encode()))
    with pytest.raises(ValueError) as exc_info:  # noqa: PT011 - message asserted below
        GcpSecretManagerSecretProvider(secret=_SECRET, client=client, start_refresh=False)
    exc = exc_info.value
    assert "is not valid JSON" in str(exc)
    assert leak not in str(exc)  # the payload is never echoed
    # The JSONDecodeError (whose .doc holds the payload) is not chained as the cause.
    assert exc.__cause__ is None


def test_non_utf8_payload_fails_closed_without_leaking_payload() -> None:
    # Invalid UTF-8 bytes (e.g. a binary secret) fail loudly; the bytes are never echoed.
    leak = b"\xff\xfe-SECRET-binary-leak"
    client = _mock_client(return_value=_response(leak))
    with pytest.raises(ValueError) as exc_info:  # noqa: PT011 - message asserted below
        GcpSecretManagerSecretProvider(secret=_SECRET, client=client, start_refresh=False)
    exc = exc_info.value
    assert "is not valid UTF-8" in str(exc)
    assert "SECRET-binary-leak" not in str(exc)
    # The UnicodeDecodeError (whose .object holds the raw bytes) is not chained as the cause.
    assert exc.__cause__ is None


def test_empty_secret_rejected() -> None:
    with pytest.raises(ValueError, match="KEEL_GCP_SECRET must be set"):
        GcpSecretManagerSecretProvider(secret="", client=_mock_client(), start_refresh=False)


# -- bounded request timeout + retry (ADR-0023 hard-timeout rule) ------------------


def test_access_applies_bounded_request_timeout_and_retry() -> None:
    """The AccessSecretVersion call carries an explicit timeout and a bounded retry.

    Without them the eager startup load inherits the SDK's minutes-long defaults, so a
    wedged Secret Manager or a degraded ADC/metadata path stalls startup. Assert the bound
    so it cannot silently regress.
    """
    client = _mock_client(return_value=_json_response({"k": "v"}))
    with GcpSecretManagerSecretProvider(secret=_SECRET, client=client, start_refresh=False):
        pass
    kwargs = client.access_secret_version.call_args.kwargs
    assert kwargs["timeout"] == _REQUEST_TIMEOUT_SECONDS
    retry = kwargs["retry"]
    assert retry is not None


def test_bounded_retry_is_time_capped() -> None:
    retry = _bounded_retry()
    # google-api-core exposes the overall cap as .timeout (newer) or ._timeout.
    cap = getattr(retry, "timeout", None)
    if cap is None:
        cap = retry._timeout  # noqa: SLF001 - version-compat fallback
    assert cap == _RETRY_TIMEOUT_SECONDS


# -- no-leak invariant (ADR-0023/0024) ---------------------------------------------


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
    # Good first load, then a failing refresh whose error body carries a credential canary
    # (a permission-denied detail could echo a token); the core must log neither.
    client = _mock_client(
        side_effect=[
            _json_response({"db_password": secret_value}),
            PermissionError(f"caller lacks access; token {_CREDENTIAL_CANARY}"),
        ]
    )
    logger = _RecordingLogger()
    with GcpSecretManagerSecretProvider(
        secret=_SECRET, client=client, logger=logger, start_refresh=False
    ) as provider:
        provider._refresh_once()  # noqa: SLF001 - exercising the refresh path directly
        assert provider.get("db_password") == secret_value  # last good map still served
    captured = logger.text
    assert logger.records  # the failure was actually logged
    assert secret_value not in captured
    assert _CREDENTIAL_CANARY not in captured


# -- fail-closed backend selection (ADR-0024) --------------------------------------


def test_selection_rejects_multiple_backends() -> None:
    with pytest.raises(ValueError, match="multiple secret backends configured"):
        secret_provider_from_env(
            environ={
                "KEEL_AWS_SECRET_ID": "aws-secret",
                "KEEL_GCP_SECRET": _SECRET,
            }
        )


def test_selection_rejects_vault_and_gcp_together() -> None:
    with pytest.raises(ValueError, match="multiple secret backends configured"):
        secret_provider_from_env(
            environ={
                "KEEL_VAULT_ADDR": "http://127.0.0.1:8200",
                "KEEL_GCP_SECRET": _SECRET,
            }
        )


def test_selection_ignores_whitespace_only_gcp_var() -> None:
    provider = secret_provider_from_env(environ={"KEEL_GCP_SECRET": "   ", "KEEL_SECRET_Z": "z"})
    assert isinstance(provider, EnvSecretProvider)


def test_factory_builds_gcp_when_secret_set(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _mock_client(return_value=_json_response({"db_password": "pw"}))
    monkeypatch.setattr("keel_core.adapters.outbound.secrets.gcp._build_client", lambda: client)
    provider = secret_provider_from_env(
        environ={
            "KEEL_GCP_SECRET": _SECRET,
            "KEEL_GCP_SECRET_VERSION": "7",
            "KEEL_SECRET_CACHE_TTL_SECONDS": "3600",  # long TTL: thread parks, no refresh in-test
        }
    )
    assert isinstance(provider, GcpSecretManagerSecretProvider)
    assert not isinstance(provider, (AwsSecretsManagerSecretProvider, OpenBaoSecretProvider))
    assert provider.get("db_password") == "pw"
    assert client.access_secret_version.call_args.kwargs["name"] == f"{_SECRET}/versions/7"
    provider.close()
