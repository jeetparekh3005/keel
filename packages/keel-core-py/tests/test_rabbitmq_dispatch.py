"""RabbitMQ per-message ack/nack/dead-letter logic (ADR-0025), unit-tested without a broker."""

from typing import Any

import pytest
from opentelemetry import trace as otel_trace

pytest.importorskip("aio_pika")

from keel_core.adapters.outbound.messaging.rabbitmq import (
    Disposition,
    RabbitMqMessageBus,
    disposition,
)
from keel_core.ports.messaging import InboundMessage


class _FakeMessage:
    """A broker-free stand-in for an aio-pika incoming message with ack/nack flags."""

    def __init__(self, *, num_delivered: int = 1) -> None:
        self.routing_key = "keel.test.events"
        self.body = b"payload"
        # x-delivery-count is the 0-based count of prior redelivery attempts, so a
        # 1-based num_delivered of N corresponds to N-1 here.
        self.headers: dict[str, Any] = {"x-delivery-count": num_delivered - 1}
        self.acked = False
        self.nacked = False
        self.requeued = False

    async def ack(self) -> None:
        self.acked = True

    async def nack(self, *, requeue: bool = False) -> None:
        self.nacked = True
        self.requeued = requeue


class _FakeExchange:
    """Records dead-letter publishes so the terminal path is assertable."""

    def __init__(self) -> None:
        self.published: list[tuple[bytes, str]] = []

    async def publish(self, message: Any, *, routing_key: str) -> None:
        self.published.append((message.body, routing_key))


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


def _bus(logger: _RecordingLogger | None = None) -> RabbitMqMessageBus:
    bus = RabbitMqMessageBus(
        "amqp://unused",
        exchange="keel-test",
        queue="keel-test",
        subjects=["keel.test.#"],
        max_deliver=5,
        logger=logger,  # type: ignore[arg-type]
    )
    bus._dlx = _FakeExchange()  # type: ignore[assignment]  # noqa: SLF001
    return bus


def test_disposition_acks_on_success_regardless_of_delivery_count() -> None:
    assert disposition(handler_ok=True, num_delivered=1, max_deliver=5) is Disposition.ACK
    assert disposition(handler_ok=True, num_delivered=99, max_deliver=5) is Disposition.ACK


def test_disposition_redelivers_under_the_cap_then_dead_letters_at_it() -> None:
    assert disposition(handler_ok=False, num_delivered=1, max_deliver=5) is Disposition.REDELIVER
    assert disposition(handler_ok=False, num_delivered=4, max_deliver=5) is Disposition.REDELIVER
    assert disposition(handler_ok=False, num_delivered=5, max_deliver=5) is Disposition.DEAD_LETTER
    assert disposition(handler_ok=False, num_delivered=6, max_deliver=5) is Disposition.DEAD_LETTER


async def test_dispatch_runs_handler_under_incoming_trace_context() -> None:
    # A message carrying a known W3C traceparent must be dispatched to the handler
    # under a context whose trace_id equals that header's (propagate.extract +
    # context.attach), proving RabbitMQ consumer trace-continuity without a broker.
    trace_id = "0af7651916cd43dd8448eb211c80319c"
    span_id = "b7ad6b7169203331"
    seen: dict[str, str] = {}

    async def handler(_: InboundMessage) -> None:
        span_context = otel_trace.get_current_span().get_span_context()
        seen["trace_id"] = format(span_context.trace_id, "032x")

    msg = _FakeMessage()
    msg.headers["traceparent"] = f"00-{trace_id}-{span_id}-01"
    await _bus()._dispatch(msg, handler)  # type: ignore[arg-type]  # noqa: SLF001
    assert seen["trace_id"] == trace_id


async def test_ack_on_success() -> None:
    async def handler(_: InboundMessage) -> None:
        return

    msg = _FakeMessage()
    await _bus()._dispatch(msg, handler)  # type: ignore[arg-type]  # noqa: SLF001
    assert msg.acked
    assert not msg.nacked


async def test_nack_with_requeue_on_failure_below_max_deliver() -> None:
    async def handler(_: InboundMessage) -> None:
        raise ValueError("boom")

    msg = _FakeMessage(num_delivered=1)
    await _bus()._dispatch(msg, handler)  # type: ignore[arg-type]  # noqa: SLF001
    assert msg.nacked
    assert msg.requeued
    assert not msg.acked


async def test_dead_letter_at_max_deliver() -> None:
    async def handler(_: InboundMessage) -> None:
        raise ValueError("poison")

    bus = _bus()
    msg = _FakeMessage(num_delivered=5)  # == max_deliver -> dead-letter instead of looping
    await bus._dispatch(msg, handler)  # type: ignore[arg-type]  # noqa: SLF001
    # Published to the dead-letter exchange with the original routing key, then acked
    # (removed from the source queue); never nack-requeued back into the loop.
    assert bus._dlx.published == [(b"payload", "keel.test.events")]  # type: ignore[union-attr]  # noqa: SLF001
    assert msg.acked
    assert not msg.nacked


async def test_terminated_message_is_logged_not_dropped_silently() -> None:
    async def handler(_: InboundMessage) -> None:
        raise ValueError("poison")

    logger = _RecordingLogger()
    msg = _FakeMessage(num_delivered=5)
    await _bus(logger)._dispatch(msg, handler)  # type: ignore[arg-type]  # noqa: SLF001
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
    msg = _FakeMessage(num_delivered=1)
    await _bus(logger)._dispatch(msg, handler)  # type: ignore[arg-type]  # noqa: SLF001
    assert any(c[0] == "warning" for c in logger.calls)


async def test_control_call_failure_is_logged_not_raised() -> None:
    async def handler(_: InboundMessage) -> None:
        return

    logger = _RecordingLogger()
    msg = _FakeMessage()

    async def _boom() -> None:
        raise RuntimeError("ack failed")

    msg.ack = _boom  # type: ignore[method-assign]
    # A failed ack must be logged, not propagate out of the dispatch callback.
    await _bus(logger)._dispatch(msg, handler)  # type: ignore[arg-type]  # noqa: SLF001
    assert any(c[0] == "exception" for c in logger.calls)
