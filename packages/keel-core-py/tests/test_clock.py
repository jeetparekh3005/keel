from datetime import UTC, datetime

from keel_core.adapters.outbound.clock import SystemClock
from keel_core.testkit.fakes import FrozenClock


def test_system_clock_is_tz_aware_utc():
    now = SystemClock().now()
    assert now.tzinfo is not None
    assert now.utcoffset() == UTC.utcoffset(None)


def test_frozen_clock_returns_fixed_instant():
    instant = datetime(2026, 1, 1, tzinfo=UTC)
    assert FrozenClock(instant).now() == instant
