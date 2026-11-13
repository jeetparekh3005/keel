"""Behavioural contract for MessageBus adapters.

Any MessageBus (InMemory, NATS, ...) must pass this: a published payload and
its custom headers are delivered to a subscriber of the same subject. Async
brokers deliver out-of-band, so delivery is awaited with a bounded poll.

With ``check_trace=True`` the helper also proves trace-context continuity: it
publishes inside an active span and asserts the consumer handler runs under a
context whose trace_id equals the producer's, i.e. ``traceparent`` is injected on
publish and re-attached (``propagate.extract`` + ``context.attach``) around the
handler. This is the same property Rust/Go/Java/TS assert for their buses.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from opentelemetry import trace as otel_trace
from opentelemetry.sdk.trace import TracerProvider

if TYPE_CHECKING:
    from keel_core.ports.messaging import InboundMessage, MessageBus


async def assert_pubsub_roundtrip(
    bus: MessageBus,
    *,
    subject: str = "keel.test.events",
    timeout: float = 5.0,  # noqa: ASYNC109  # contract helper: bounded wait for async delivery
    check_trace: bool = False,
) -> None:
    """Subscribe, publish, and assert the message is delivered intact within ``timeout``.

    When ``check_trace`` is set, the publish happens inside an active span and the
    consumer's observed trace_id is asserted to equal the producer's.
    """
    received: list[InboundMessage] = []
    observed_trace_ids: list[str] = []

    async def handler(message: InboundMessage) -> None:
        if check_trace:
            span_context = otel_trace.get_current_span().get_span_context()
            observed_trace_ids.append(format(span_context.trace_id, "032x"))
        received.append(message)

    await bus.subscribe(subject, handler)

    expected_trace_id = ""
    if check_trace:
        # A local provider is enough: start_as_current_span sets the active span, and
        # publish() injects its traceparent via the global propagator.
        tracer = TracerProvider().get_tracer("keel.testkit.messaging")
        with tracer.start_as_current_span("publish") as span:
            expected_trace_id = format(span.get_span_context().trace_id, "032x")
            await bus.publish(subject, b"hello", headers={"x-demo": "1"})
    else:
        await bus.publish(subject, b"hello", headers={"x-demo": "1"})

    deadline_iters = max(1, int(timeout / 0.05))
    for _ in range(deadline_iters):
        if received:
            break
        await asyncio.sleep(0.05)

    assert received, f"no message delivered to {subject!r} within {timeout}s"
    message = received[0]
    assert message.subject == subject
    assert message.payload == b"hello"
    assert message.headers.get("x-demo") == "1"

    if check_trace:
        assert observed_trace_ids, "handler did not observe a span context"
        assert observed_trace_ids[0] == expected_trace_id, (
            "consumer trace_id must match the producer's (traceparent continuity)"
        )
