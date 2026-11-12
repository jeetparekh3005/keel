"""Shared secret redaction for every egress path (logs and exported spans).

Single source of truth for the secret-key families and the high-precision value
patterns, so redaction on the JSON log sink and on the OTLP span-export path stays
identical: the patterns live here once and are never duplicated. Family matching on
keys catches ``x-api-key``, ``access_token``, ``client_secret``, ``cookie``, etc.;
value scrubbing catches JWTs, bearer tokens, AWS access-key ids, PEM private keys,
and Luhn-valid card numbers wherever they appear in a string (even under a
non-secret key).
"""

from __future__ import annotations

import re

# Redact any field whose (normalized) key contains one of these fragments. Family
# matching catches x-api-key, access_token, client_secret, cookie, set-cookie, etc.
_SECRET_KEY_FRAGMENTS: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "cookie",
    "authorization",
    "credential",
    "privatekey",
    "pii",
)
REDACTED = "[REDACTED]"

DEFAULT_MAX_FIELD_LEN = 8192

# High-precision secret patterns scrubbed from any string value and the message.
# Deliberately narrow to avoid false positives (no "redact anything long").
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),  # JWT
    re.compile(r"AKIA[0-9A-Z]{16}"),  # AWS access key id
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/-]{8,}=*"),  # bearer token
    re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),  # PEM private key
)
_CC_CANDIDATE = re.compile(r"\b(?:\d[ -]?){13,19}\b")


def is_secret_key(key: str) -> bool:
    """Return True when ``key`` belongs to a secret family (normalized, separator-agnostic)."""
    normalized = key.lower().replace("-", "").replace("_", "")
    return any(fragment in normalized for fragment in _SECRET_KEY_FRAGMENTS)


def _luhn_ok(number: str) -> bool:
    digits = [int(d) for d in number]
    checksum = 0
    for i, digit in enumerate(reversed(digits)):
        value = digit * 2 if i % 2 == 1 else digit
        checksum += value - 9 if value > 9 else value
    return checksum % 10 == 0


def _scrub_credit_cards(text: str) -> str:
    def _replace(match: re.Match[str]) -> str:
        bare = re.sub(r"[ -]", "", match.group(0))
        return REDACTED if bare.isdigit() and _luhn_ok(bare) else match.group(0)

    return _CC_CANDIDATE.sub(_replace, text)


def scrub_text(text: str) -> str:
    """Scrub secret value patterns (JWT, bearer, AWS key, PEM, Luhn PAN) from a string."""
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(REDACTED, text)
    return _scrub_credit_cards(text)


def sanitize(value: object, max_len: int = DEFAULT_MAX_FIELD_LEN) -> object:
    """Redact secret-keyed entries, scrub secret-valued strings, and cap sizes.

    Recurses into mappings and sequences so a secret nested under any depth is caught.
    """
    if isinstance(value, dict):
        out: dict[object, object] = {}
        for key, item in value.items():
            if isinstance(key, str) and is_secret_key(key):
                out[key] = REDACTED
            else:
                out[key] = sanitize(item, max_len)
        return out
    if isinstance(value, (list, tuple)):
        return [sanitize(item, max_len) for item in value]
    if isinstance(value, (str, bytes, bytearray)):
        # bytes values are decoded (lossily) so value-pattern scrubbing (JWT, bearer,
        # AWS key, PAN) applies to byte payloads too; otherwise a secret in a bytes value
        # under a non-secret key would be emitted verbatim by the JSON renderer's repr.
        text = value if isinstance(value, str) else bytes(value).decode("utf-8", errors="replace")
        scrubbed = scrub_text(text)
        if len(scrubbed) > max_len:
            return f"{scrubbed[:max_len]}...(truncated {len(scrubbed) - max_len} chars)"
        return scrubbed
    return value
