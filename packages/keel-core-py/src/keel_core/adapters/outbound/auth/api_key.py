"""API-key Authenticator adapter (platform.yaml auth; ADR-0006).

Verifies an opaque API key against a configured set of SHA-256 key hashes and
maps it to a Principal. Keys are stored **hashed** (never plaintext) so a memory
disclosure does not leak usable credentials; the presented key is hashed and
looked up. Keys/hashes should come from the ``SecretProvider``, not source.
"""

from __future__ import annotations

import hashlib

from keel_core.domain.errors import Unauthenticated
from keel_core.ports.auth import Principal


def hash_api_key(key: str) -> str:
    """Return the SHA-256 hex digest used to store and look up an API key."""
    return hashlib.sha256(key.encode()).hexdigest()


class ApiKeyAuthenticator:
    """Authenticator backed by a fixed set of API-key hashes -> Principal."""

    def __init__(self, key_hashes: dict[str, Principal]) -> None:
        """Initialize with a mapping of SHA-256 key hex digests to principals."""
        self._by_hash = dict(key_hashes)

    @classmethod
    def from_keys(cls, keys: dict[str, Principal]) -> ApiKeyAuthenticator:
        """Build from plaintext keys, hashing immediately (prefer hashes from secrets)."""
        return cls({hash_api_key(key): principal for key, principal in keys.items()})

    def authenticate(self, credential: str) -> Principal:
        """Return the principal for ``credential`` (an API key), else raise Unauthenticated.

        Lookup is by SHA-256 digest; because the key is high-entropy, the hashed
        lookup is not a practical timing oracle for the key's contents.
        """
        principal = self._by_hash.get(hash_api_key(credential))
        if principal is None:
            msg = "invalid api key"
            raise Unauthenticated(msg)
        return principal
