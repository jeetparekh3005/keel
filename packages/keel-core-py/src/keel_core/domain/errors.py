"""Domain error taxonomy mapped to the platform error contract (RFC 9457).

Every error carries a stable :class:`ErrorCategory`; inbound adapters translate
that category into an HTTP status and a ``problem+json`` body. The domain raises
these types and never leaks stack traces or internal identifiers.
"""

from __future__ import annotations

from enum import Enum
from typing import ClassVar


class ErrorCategory(Enum):
    """Stable domain error categories; each maps to one HTTP status."""

    VALIDATION = "validation"
    UNAUTHENTICATED = "unauthenticated"
    FORBIDDEN = "forbidden"
    NOT_FOUND = "not_found"
    CONFLICT = "conflict"
    RATE_LIMITED = "rate_limited"
    INTERNAL = "internal"
    UNAVAILABLE = "unavailable"


_STATUS: dict[ErrorCategory, int] = {
    ErrorCategory.VALIDATION: 400,
    ErrorCategory.UNAUTHENTICATED: 401,
    ErrorCategory.FORBIDDEN: 403,
    ErrorCategory.NOT_FOUND: 404,
    ErrorCategory.CONFLICT: 409,
    ErrorCategory.RATE_LIMITED: 429,
    ErrorCategory.INTERNAL: 500,
    ErrorCategory.UNAVAILABLE: 503,
}


def http_status(category: ErrorCategory) -> int:
    """Return the HTTP status code for a category."""
    return _STATUS[category]


class DomainError(Exception):
    """Base class for domain errors carrying a taxonomy category and title."""

    category: ClassVar[ErrorCategory] = ErrorCategory.INTERNAL
    title: ClassVar[str] = "Internal Server Error"

    def __init__(self, detail: str | None = None) -> None:
        """Initialize with an optional human-readable detail."""
        self.detail = detail
        super().__init__(detail or self.title)

    @property
    def status(self) -> int:
        """HTTP status code for this error's category."""
        return http_status(self.category)


class ValidationFailed(DomainError):
    """The request was syntactically or semantically invalid."""

    category = ErrorCategory.VALIDATION
    title = "Validation Failed"


class Unauthenticated(DomainError):
    """The caller could not be authenticated."""

    category = ErrorCategory.UNAUTHENTICATED
    title = "Unauthenticated"


class Forbidden(DomainError):
    """The caller is authenticated but not authorized."""

    category = ErrorCategory.FORBIDDEN
    title = "Forbidden"


class NotFound(DomainError):
    """The requested resource does not exist."""

    category = ErrorCategory.NOT_FOUND
    title = "Not Found"


class Conflict(DomainError):
    """The request conflicts with current state."""

    category = ErrorCategory.CONFLICT
    title = "Conflict"


class RateLimited(DomainError):
    """The caller has exceeded a rate limit."""

    category = ErrorCategory.RATE_LIMITED
    title = "Too Many Requests"


class Unavailable(DomainError):
    """A required dependency is unavailable."""

    category = ErrorCategory.UNAVAILABLE
    title = "Service Unavailable"
