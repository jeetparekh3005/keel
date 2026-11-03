import pytest

from keel_core.domain.errors import (
    Conflict,
    DomainError,
    ErrorCategory,
    Forbidden,
    NotFound,
    Unauthenticated,
    ValidationFailed,
    http_status,
)


@pytest.mark.parametrize(
    ("category", "status"),
    [
        (ErrorCategory.VALIDATION, 400),
        (ErrorCategory.UNAUTHENTICATED, 401),
        (ErrorCategory.FORBIDDEN, 403),
        (ErrorCategory.NOT_FOUND, 404),
        (ErrorCategory.CONFLICT, 409),
        (ErrorCategory.RATE_LIMITED, 429),
        (ErrorCategory.INTERNAL, 500),
        (ErrorCategory.UNAVAILABLE, 503),
    ],
)
def test_every_category_maps_to_a_status(category, status):
    assert http_status(category) == status


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (ValidationFailed, 400),
        (Unauthenticated, 401),
        (Forbidden, 403),
        (NotFound, 404),
        (Conflict, 409),
    ],
)
def test_domain_errors_expose_status(error, status):
    assert error("detail").status == status


def test_detail_falls_back_to_title():
    assert str(NotFound()) == "Not Found"
    assert NotFound("missing").detail == "missing"


def test_domain_error_is_an_exception():
    with pytest.raises(DomainError):
        raise ValidationFailed("bad input")
