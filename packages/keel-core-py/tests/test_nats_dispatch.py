"""NATS per-message ack/nak/term logic (audit #120), unit-tested without a broker."""

from types import SimpleNamespace

import pytest

pytest.importorskip("nats")

from keel_core.adapters.outbound.messaging.nats import NatsMessageBus
from keel_core.ports.messaging import InboundMessage


class _FakeMsg:
    def __init__(self, *, num_delivered: int = 1) -> None:
        self.subject = "keel.test.events"
        self.data = b"payload"
        self.headers: dict[str, str] = {}
        self.metadata = SimpleNamespace(num_delivered=num_delivered)
        self.acked = self.nakked = self.termed = False

    async def ack(self) -> None:
        self.acked = True

    async def nak(self) -> None:
        self.nakked = True

    async def term(self) -> None:
        self.termed = True


def _bus() -> NatsMessageBus:
    return NatsMessageBus(
        "nats://unused", stream="keel-test", subjects=["keel.test.>"], max_deliver=5
    )


async def test_ack_on_success() -> None:
    async def handler(_: InboundMessage) -> None:
        return

    msg = _FakeMsg()
    await _bus()._dispatch(msg, handler)  # noqa: SLF001
    assert msg.acked
    assert not msg.nakked
    assert not msg.termed


async def test_nak_on_failure_below_max_deliver() -> None:
    async def handler(_: InboundMessage) -> None:
        raise ValueError("boom")

    msg = _FakeMsg(num_delivered=1)
    await _bus()._dispatch(msg, handler)  # noqa: SLF001
    assert msg.nakked
    assert not msg.acked
    assert not msg.termed


async def test_term_on_failure_at_max_deliver() -> None:
    async def handler(_: InboundMessage) -> None:
        raise ValueError("poison")

    msg = _FakeMsg(num_delivered=5)  # == max_deliver -> dead-letter instead of looping
    await _bus()._dispatch(msg, handler)  # noqa: SLF001
    assert msg.termed
    assert not msg.acked
    assert not msg.nakked
