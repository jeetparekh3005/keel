"""Behavioural contract for MessageBus adapters.

Any MessageBus (InMemory, NATS, ...) must pass this: a published payload and
its custom headers are delivered to a subscriber of the same subject. Async
brokers deliver out-of-band, so delivery is awaited with a bounded poll.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from keel_core.ports.messaging import InboundMessage, MessageBus


async def assert_pubsub_roundtrip(
    bus: MessageBus,
    *,
    subject: str = "keel.test.events",
    timeout: float = 5.0,  # noqa: ASYNC109  # contract helper: bounded wait for async delivery
) -> None:
    """Subscribe, publish, and assert the message is delivered intact within ``timeout``."""
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    await bus.subscribe(subject, handler)
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
