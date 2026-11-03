from opentelemetry import trace as otel_trace
from opentelemetry.sdk.trace import TracerProvider

from keel_core.adapters.outbound.messaging import InMemoryMessageBus
from keel_core.ports.messaging import InboundMessage


async def test_publish_delivers_to_subscribers():
    bus = InMemoryMessageBus()
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    await bus.subscribe("orders.created", handler)
    await bus.publish("orders.created", b"payload")

    assert len(received) == 1
    assert received[0].payload == b"payload"
    assert received[0].subject == "orders.created"


async def test_publish_with_no_subscribers_is_noop():
    await InMemoryMessageBus().publish("nobody.listening", b"x")


async def test_only_matching_subject_is_delivered():
    bus = InMemoryMessageBus()
    hits = []

    async def handler(_: InboundMessage) -> None:
        hits.append(1)

    await bus.subscribe("a", handler)
    await bus.publish("b", b"x")
    assert hits == []


async def test_trace_context_propagates_to_handler():
    tracer = TracerProvider().get_tracer("test")
    bus = InMemoryMessageBus()
    seen: dict[str, str] = {}

    async def handler(_: InboundMessage) -> None:
        span_context = otel_trace.get_current_span().get_span_context()
        seen["trace_id"] = format(span_context.trace_id, "032x")

    await bus.subscribe("events", handler)
    with tracer.start_as_current_span("publish") as span:
        expected = format(span.get_span_context().trace_id, "032x")
        await bus.publish("events", b"x")

    assert seen["trace_id"] == expected
