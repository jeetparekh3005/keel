"""OpenBaoSecretProvider against a real OpenBao dev server (ADR-0023).

Runs only when KEEL_VAULT_ADDR is set (CI starts an openbao:2.7.2 dev server);
skipped otherwise. Writes a KV v2 secret with a static token, then reads it back
through the adapter to prove end-to-end behavior against a real Vault endpoint.
"""

from __future__ import annotations

import json
import os
import urllib.request

import pytest

from keel_core.adapters.outbound.secrets import OpenBaoSecretProvider

_ADDR = os.environ.get("KEEL_VAULT_ADDR")
_TOKEN = os.environ.get("KEEL_VAULT_TOKEN", "root")
_MOUNT = os.environ.get("KEEL_VAULT_MOUNT", "secret")
_PATH = os.environ.get("KEEL_VAULT_PATH", "keel-test")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(_ADDR is None, reason="KEEL_VAULT_ADDR not set"),
]


def _write_secret(fields: dict[str, str]) -> None:
    body = json.dumps({"data": fields}).encode("utf-8")
    request = urllib.request.Request(
        f"{_ADDR}/v1/{_MOUNT}/data/{_PATH}",
        data=body,
        headers={"X-Vault-Token": _TOKEN, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        assert response.status in (200, 204)


def test_roundtrips_a_real_kv_secret() -> None:
    assert _ADDR is not None
    _write_secret({"db_password": "integration-pw", "api_key": "k-123"})
    with OpenBaoSecretProvider(
        addr=_ADDR,
        path=_PATH,
        token=_TOKEN,
        mount=_MOUNT,
        start_refresh=False,
    ) as provider:
        assert provider.get("db_password") == "integration-pw"
        assert provider.get("api_key") == "k-123"
        assert provider.get_optional("nope") is None
