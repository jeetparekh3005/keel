"""Production entrypoint wiring: fail-fast on missing OIDC, state wired (audit #65)."""

import pytest


def test_main_wiring_and_oidc_fail_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    # Valid OIDC env so the module-level app builds on first import.
    monkeypatch.setenv("KEEL_DATABASE_URL", "sqlite+aiosqlite://")
    monkeypatch.setenv("KEEL_OIDC_ISSUER", "https://issuer.example")
    monkeypatch.setenv("KEEL_OIDC_AUDIENCE", "keel-api")
    monkeypatch.setenv("KEEL_OIDC_JWKS_URI", "https://issuer.example/jwks")

    import reference_service.main as main

    # The composed app is fully wired (persistence + observability on state).
    assert main.app.state.database is not None
    assert main.app.state.tracer_provider is not None
    assert main.app.state.meter_provider is not None

    # Fail-fast: no insecure fallback authenticator when OIDC is unconfigured.
    for var in ("KEEL_OIDC_ISSUER", "KEEL_OIDC_AUDIENCE", "KEEL_OIDC_JWKS_URI"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(RuntimeError, match="OIDC config required"):
        main.create_application()
