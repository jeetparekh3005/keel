"""Unit tests for OpenBaoSecretProvider against an in-process mock Vault (ADR-0023).

The mock is a stdlib http.server running in a thread; it records every request
(method, path, headers, body) and serves programmable responses so we can assert the
exact wire shape the ADR specifies (paths, X-Vault-Token/Namespace headers, the
Kubernetes login body) and that a known secret value round-trips.
"""

from __future__ import annotations

import json
import ssl
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from keel_core.adapters.outbound.secrets import (
    EnvSecretProvider,
    OpenBaoSecretProvider,
    secret_provider_from_env,
)


@dataclass
class _Recorded:
    method: str
    path: str
    headers: dict[str, str]
    body: dict[str, Any] | None


@dataclass
class _MockVault:
    """Programmable state for the mock Vault, shared with the request handler."""

    kv: dict[str, Any] | None = field(default_factory=dict)  # None => 404 at the path
    client_token: str = "s.servertoken"
    lease_duration: int = 3600
    fail_next_reads: int = 0  # return `fail_status` for the next N reads, then succeed
    fail_status: int = 403
    malformed_next_reads: int = 0  # return a 200 with `malformed_body` for the next N reads
    malformed_body: bytes = b"not-json"
    requests: list[_Recorded] = field(default_factory=list)

    @property
    def reads(self) -> list[_Recorded]:
        return [r for r in self.requests if r.method == "GET"]

    @property
    def logins(self) -> list[_Recorded]:
        return [r for r in self.requests if r.method == "POST" and r.path.endswith("/login")]


def _make_handler(state: _MockVault) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: Any) -> None:  # silence test-server logging
            return

        def _record(self, body: dict[str, Any] | None) -> None:
            state.requests.append(
                _Recorded(
                    method=self.command,
                    path=self.path,
                    headers=dict(self.headers.items()),
                    body=body,
                )
            )

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _read_body(self) -> dict[str, Any] | None:
            length = int(self.headers.get("Content-Length", "0"))
            if length == 0:
                return None
            return json.loads(self.rfile.read(length))

        def do_POST(self) -> None:
            body = self._read_body()
            self._record(body)
            if self.path.endswith("/login"):
                auth = {"client_token": state.client_token, "lease_duration": state.lease_duration}
                self._send_json(200, {"auth": auth})
                return
            self._send_json(404, {"errors": []})

        def _send_raw(self, status: int, raw: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:
            self._record(None)
            if state.fail_next_reads > 0:
                state.fail_next_reads -= 1
                self._send_json(state.fail_status, {"errors": ["denied"]})
                return
            if state.malformed_next_reads > 0:
                state.malformed_next_reads -= 1
                self._send_raw(200, state.malformed_body)  # 200 OK, body is not valid JSON
                return
            if state.kv is None:
                self._send_json(404, {"errors": []})
                return
            self._send_json(200, {"data": {"data": state.kv, "metadata": {"version": 1}}})

    return Handler


@pytest.fixture
def mock_vault() -> Any:
    state = _MockVault()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    addr = f"http://{host}:{port}"
    try:
        yield addr, state
    finally:
        server.shutdown()
        server.server_close()


def test_token_auth_read_roundtrips(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = {"db_password": "s3cret", "api_key": "abc"}
    with OpenBaoSecretProvider(
        addr=addr, path="keel-test", token="root", start_refresh=False
    ) as provider:
        assert provider.get("db_password") == "s3cret"
        assert provider.get_optional("api_key") == "abc"
    # No Kubernetes login; a single read at construction, from the KV v2 data path.
    assert state.logins == []
    assert len(state.reads) == 1
    read = state.reads[0]
    assert read.path == "/v1/secret/data/keel-test"
    assert read.headers["X-Vault-Token"] == "root"


def test_kubernetes_login_then_read(mock_vault: Any, tmp_path: Any) -> None:
    addr, state = mock_vault
    state.kv = {"token": "value"}
    jwt_file = tmp_path / "sa-token"
    jwt_file.write_text("the-jwt-blob\n")
    with OpenBaoSecretProvider(
        addr=addr,
        path="keel-test",
        role="keel-role",
        k8s_mount="k8s",
        k8s_jwt_path=str(jwt_file),
        start_refresh=False,
    ) as provider:
        assert provider.get("token") == "value"
    assert len(state.logins) == 1
    login = state.logins[0]
    assert login.path == "/v1/auth/k8s/login"
    assert login.body == {"role": "keel-role", "jwt": "the-jwt-blob"}
    # The read uses the client_token returned by login, not the (absent) static token.
    assert state.reads[0].headers["X-Vault-Token"] == state.client_token


def test_cache_hit_serves_without_network(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = {"k": "v"}
    with OpenBaoSecretProvider(
        addr=addr, path="keel-test", token="root", start_refresh=False
    ) as provider:
        provider.get("k")
        provider.get("k")
        provider.get_optional("missing")
    assert len(state.reads) == 1  # all gets served from cache; only the init load hit the server


def test_ttl_expiry_refetches(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = {"k": "old"}
    with OpenBaoSecretProvider(
        addr=addr, path="keel-test", token="root", cache_ttl_seconds=0.05
    ) as provider:
        assert provider.get("k") == "old"
        state.kv = {"k": "new"}
        deadline = time.monotonic() + 3.0
        while provider.get("k") != "new" and time.monotonic() < deadline:
            time.sleep(0.05)
        assert provider.get("k") == "new"
    assert len(state.reads) >= 2


def test_404_makes_all_keys_absent(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = None  # 404 at the path
    with OpenBaoSecretProvider(
        addr=addr, path="keel-test", token="root", start_refresh=False
    ) as provider:
        assert provider.get_optional("anything") is None
        with pytest.raises(KeyError):
            provider.get("anything")


def test_403_during_refresh_reauths_and_retries(mock_vault: Any, tmp_path: Any) -> None:
    addr, state = mock_vault
    state.kv = {"k": "v1"}
    jwt_file = tmp_path / "sa-token"
    jwt_file.write_text("jwt")
    with OpenBaoSecretProvider(
        addr=addr,
        path="keel-test",
        role="keel-role",
        k8s_jwt_path=str(jwt_file),
        start_refresh=False,
    ) as provider:
        assert len(state.logins) == 1  # construction login
        state.kv = {"k": "v2"}
        state.fail_next_reads = 1  # next read 403s -> re-login + retry
        provider._refresh_once()  # noqa: SLF001 - exercising the refresh path directly
        assert provider.get("k") == "v2"
    assert len(state.logins) == 2  # construction + one re-auth


def test_namespace_header_sent_when_set(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = {"k": "v"}
    with OpenBaoSecretProvider(
        addr=addr, path="keel-test", token="root", namespace="team-a", start_refresh=False
    ):
        pass
    assert state.reads[0].headers["X-Vault-Namespace"] == "team-a"


def test_namespace_header_absent_when_unset(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = {"k": "v"}
    with OpenBaoSecretProvider(addr=addr, path="keel-test", token="root", start_refresh=False):
        pass
    assert "X-Vault-Namespace" not in state.reads[0].headers


def test_refresh_failure_keeps_last_good(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = {"k": "good"}
    with OpenBaoSecretProvider(
        addr=addr, path="keel-test", token="root", start_refresh=False
    ) as provider:
        state.fail_next_reads = 1
        state.fail_status = 500
        provider._refresh_once()  # noqa: SLF001 - exercising the refresh path directly
        assert provider.get("k") == "good"  # last good field map still served


def test_fail_closed_when_addr_set_without_auth() -> None:
    with pytest.raises(ValueError, match="no Vault auth configured"):
        secret_provider_from_env(
            environ={"KEEL_VAULT_ADDR": "http://127.0.0.1:1", "KEEL_VAULT_PATH": "p"}
        )


def test_fail_closed_when_path_missing() -> None:
    with pytest.raises(ValueError, match="KEEL_VAULT_PATH is required"):
        secret_provider_from_env(
            environ={"KEEL_VAULT_ADDR": "http://127.0.0.1:1", "KEEL_VAULT_TOKEN": "root"}
        )


def test_factory_returns_env_provider_when_addr_unset() -> None:
    provider = secret_provider_from_env(environ={"KEEL_SECRET_X": "y"})
    assert isinstance(provider, EnvSecretProvider)
    assert provider.get("x") == "y"


def test_factory_builds_openbao_when_addr_set(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = {"db_password": "pw"}
    provider = secret_provider_from_env(
        environ={
            "KEEL_VAULT_ADDR": addr,
            "KEEL_VAULT_TOKEN": "root",
            "KEEL_VAULT_PATH": "keel-test",
            "KEEL_VAULT_CACHE_TTL_SECONDS": "3600",  # long TTL: thread parks, no refresh in-test
        }
    )
    assert isinstance(provider, OpenBaoSecretProvider)
    assert provider.get("db_password") == "pw"
    provider.close()


def test_expiring_lease_triggers_relogin_before_read(mock_vault: Any, tmp_path: Any) -> None:
    addr, state = mock_vault
    state.kv = {"k": "v"}
    state.lease_duration = 1  # deadline within the renew skew => already "expiring"
    jwt_file = tmp_path / "sa-token"
    jwt_file.write_text("jwt")
    with OpenBaoSecretProvider(
        addr=addr,
        path="keel-test",
        role="keel-role",
        k8s_jwt_path=str(jwt_file),
        start_refresh=False,
    ) as provider:
        assert len(state.logins) == 1  # construction login
        provider._refresh_once()  # noqa: SLF001 - exercising the refresh path directly
    # The near-expiry lease forces a re-login ahead of the refresh read.
    assert len(state.logins) == 2


def test_https_cacert_builds_tls_context(tmp_path: Any) -> None:
    # Construction fails fast (no server), but the TLS context must be built first for https.
    pem = tmp_path / "ca.pem"
    pem.write_text("-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n")
    with pytest.raises(ssl.SSLError):
        OpenBaoSecretProvider(
            addr="https://127.0.0.1:1",
            path="keel-test",
            token="root",
            cacert=str(pem),
            start_refresh=False,
        )


def test_empty_addr_rejected() -> None:
    with pytest.raises(ValueError, match="KEEL_VAULT_ADDR must be set"):
        OpenBaoSecretProvider(addr="", path="p", token="root")


# -- field coercion (ADR-0023) ----------------------------------------------------


def test_field_coercion_is_canonical_not_python_repr(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = {
        "name": "alice",
        "flag_true": True,
        "flag_false": False,
        "count": 3,
        "ratio": 3.5,
        "obj": {"a": 1},
        "arr": [1, 2],
        "nothing": None,
    }
    with OpenBaoSecretProvider(
        addr=addr, path="keel-test", token="root", start_refresh=False
    ) as provider:
        # JSON string verbatim; number -> JSON text; boolean -> lowercase true/false.
        assert provider.get("name") == "alice"
        assert provider.get("count") == "3"
        assert provider.get("ratio") == "3.5"
        assert provider.get("flag_true") == "true"  # not Python "True"
        assert provider.get("flag_false") == "false"  # not Python "False"
        # Object/array/null are not scalar secrets: absent, never a Python repr.
        for absent in ("obj", "arr", "nothing"):
            assert provider.get_optional(absent) is None
            with pytest.raises(KeyError):
                provider.get(absent)


# -- cache TTL fail-closed (ADR-0023) ---------------------------------------------


@pytest.mark.parametrize("bad_ttl", [0, 0.0, -1, -0.5])
def test_constructor_rejects_non_positive_ttl(bad_ttl: float) -> None:
    # Rejected before any I/O, so no reachable server is needed.
    with pytest.raises(ValueError, match="positive integer"):
        OpenBaoSecretProvider(
            addr="http://127.0.0.1:1",
            path="p",
            token="root",
            cache_ttl_seconds=bad_ttl,
            start_refresh=False,
        )


@pytest.mark.parametrize("bad_ttl", ["0", "-1", "abc", "3.5", "", "  "])
def test_factory_rejects_non_positive_or_unparseable_ttl(bad_ttl: str) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        secret_provider_from_env(
            environ={
                "KEEL_VAULT_ADDR": "http://127.0.0.1:1",
                "KEEL_VAULT_TOKEN": "root",
                "KEEL_VAULT_PATH": "p",
                "KEEL_VAULT_CACHE_TTL_SECONDS": bad_ttl,
            }
        )


def test_factory_defaults_ttl_to_60_when_unset(mock_vault: Any) -> None:
    addr, state = mock_vault
    state.kv = {"k": "v"}
    provider = secret_provider_from_env(
        environ={
            "KEEL_VAULT_ADDR": addr,
            "KEEL_VAULT_TOKEN": "root",
            "KEEL_VAULT_PATH": "keel-test",
        }
    )
    assert isinstance(provider, OpenBaoSecretProvider)
    try:
        assert provider._ttl == 60.0  # noqa: SLF001 - asserting the unset default
    finally:
        provider.close()


# -- no-leak invariant (ADR-0023) -------------------------------------------------


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


def test_refresh_failure_does_not_leak_secret_or_token(mock_vault: Any) -> None:
    addr, state = mock_vault
    secret_value = "s3cret-leak-canary-value"
    token = "root-token-leak-canary"
    state.kv = {"db_password": secret_value}
    logger = _RecordingLogger()
    with OpenBaoSecretProvider(
        addr=addr, path="keel-test", token=token, logger=logger, start_refresh=False
    ) as provider:
        # (a) a 500 refresh failure.
        state.fail_next_reads = 1
        state.fail_status = 500
        provider._refresh_once()  # noqa: SLF001 - exercising the refresh path directly
        # (b) a 200 whose body is not valid JSON and echoes the secret value.
        state.malformed_next_reads = 1
        state.malformed_body = secret_value.encode("utf-8")
        provider._refresh_once()  # noqa: SLF001 - exercising the refresh path directly
        assert provider.get("db_password") == secret_value  # last good map still served
    captured = logger.text
    assert logger.records  # the failures were actually logged
    assert secret_value not in captured
    assert token not in captured


def test_read_path_unparseable_body_error_omits_body(mock_vault: Any) -> None:
    addr, state = mock_vault
    leak = "SECRET-LEAK-xyz-in-body"
    state.kv = {"k": "v"}
    state.malformed_next_reads = 1  # the construction read gets a 200 with a non-JSON body
    state.malformed_body = leak.encode("utf-8")
    with pytest.raises(Exception) as exc_info:  # noqa: PT011 - type asserted below
        OpenBaoSecretProvider(addr=addr, path="keel-test", token="root", start_refresh=False)
    exc = exc_info.value
    assert type(exc).__name__ == "_VaultHttpError"
    # The error carries only status + path, never the response body, and the raw
    # JSONDecodeError (whose .doc holds the body) is not chained as the cause.
    assert leak not in str(exc)
    assert "keel-test" in str(exc)
    assert exc.__cause__ is None
