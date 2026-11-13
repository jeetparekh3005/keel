"""NATS per-message ack/nak/term logic (audit #120), unit-tested without a broker."""

from types import SimpleNamespace

import pytest
from opentelemetry import trace as otel_trace

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


class _RecordingLogger:
    """Captures (level, message, fields) so dispatch decisions can be asserted."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, object]]] = []

    def debug(self, message: str, **fields: object) -> None:
        self.calls.append(("debug", message, fields))

    def info(self, message: str, **fields: object) -> None:
        self.calls.append(("info", message, fields))

    def warning(self, message: str, **fields: object) -> None:
        self.calls.append(("warning", message, fields))

    def error(self, message: str, **fields: object) -> None:
        self.calls.append(("error", message, fields))

    def exception(self, message: str, **fields: object) -> None:
        self.calls.append(("exception", message, fields))


def _bus(logger: _RecordingLogger | None = None) -> NatsMessageBus:
    return NatsMessageBus(
        "nats://unused",
        stream="keel-test",
        subjects=["keel.test.>"],
        max_deliver=5,
        logger=logger,  # type: ignore[arg-type]
    )


async def test_dispatch_runs_handler_under_incoming_trace_context() -> None:
    # A message carrying a known W3C traceparent must be dispatched to the handler
    # under a context whose trace_id equals that header's (propagate.extract +
    # context.attach), proving NATS consumer trace-continuity without a broker.
    trace_id = "0af7651916cd43dd8448eb211c80319c"
    span_id = "b7ad6b7169203331"
    seen: dict[str, str] = {}

    async def handler(_: InboundMessage) -> None:
        span_context = otel_trace.get_current_span().get_span_context()
        seen["trace_id"] = format(span_context.trace_id, "032x")

    msg = _FakeMsg()
    msg.headers = {"traceparent": f"00-{trace_id}-{span_id}-01"}
    await _bus()._dispatch(msg, handler)  # noqa: SLF001
    assert seen["trace_id"] == trace_id


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


async def test_terminated_message_is_logged_not_dropped_silently() -> None:
    async def handler(_: InboundMessage) -> None:
        raise ValueError("poison")

    logger = _RecordingLogger()
    msg = _FakeMsg(num_delivered=5)
    await _bus(logger)._dispatch(msg, handler)  # noqa: SLF001
    # exception() logs at error level with the poison traceback; the dead-letter
    # must leave a record, never be dropped silently.
    terminated = [c for c in logger.calls if c[0] == "exception" and "terminated" in c[1]]
    assert terminated, "terminate must be logged so the dead-letter is not silent"
    _, _, fields = terminated[0]
    assert fields["subject"] == "keel.test.events"
    assert fields["num_delivered"] == 5


async def test_scheduled_redelivery_is_logged() -> None:
    async def handler(_: InboundMessage) -> None:
        raise ValueError("transient")

    logger = _RecordingLogger()
    msg = _FakeMsg(num_delivered=1)
    await _bus(logger)._dispatch(msg, handler)  # noqa: SLF001
    assert any(c[0] == "warning" for c in logger.calls)


async def test_control_call_failure_is_logged_not_raised() -> None:
    async def handler(_: InboundMessage) -> None:
        return

    logger = _RecordingLogger()
    msg = _FakeMsg()

    async def _boom() -> None:
        raise RuntimeError("ack failed")

    msg.ack = _boom  # type: ignore[method-assign]
    # A failed ack must be logged, not propagate out of the dispatch callback.
    await _bus(logger)._dispatch(msg, handler)  # noqa: SLF001
    assert any(c[0] == "exception" for c in logger.calls)
