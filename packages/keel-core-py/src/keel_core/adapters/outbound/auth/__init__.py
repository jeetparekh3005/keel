"""Authenticator adapters. OIDC/JWT is the default (ADR-0006)."""

from keel_core.adapters.outbound.auth.oidc import OIDCAuthenticator

__all__ = ["OIDCAuthenticator"]
