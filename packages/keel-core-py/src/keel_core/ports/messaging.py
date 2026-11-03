"""Messaging ports: publish events and consume them (platform.yaml interservice.async)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True, slots=True)
class InboundMessage:
    """A delivered message: subject, raw payload, and propagation headers."""

    subject: str
    payload: bytes
    headers: Mapping[str, str] = field(default_factory=dict)


MessageHandler = Callable[[InboundMessage], Awaitable[None]]


class MessagePublisher(Protocol):
    """Publishes events to a subject (driven port)."""

    async def publish(
        self, subject: str, payload: bytes, *, headers: Mapping[str, str] | None = None
    ) -> None:
        """Publish ``payload`` to ``subject`` with optional headers."""
        ...


class MessageBus(MessagePublisher, Protocol):
    """A publisher that also lets consumers subscribe to subjects."""

    async def subscribe(self, subject: str, handler: MessageHandler) -> None:
        """Register ``handler`` to receive messages published to ``subject``."""
        ...
