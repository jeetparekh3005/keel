package io.keel.core.ports.messaging;

import java.util.Map;

/**
 * A delivered message: its subject, the raw payload, and the propagation headers that carry the W3C
 * trace context across the broker (platform.yaml interservice.async). Mirrors the Python vertical's
 * {@code InboundMessage} so a handler sees the same shape in every language.
 *
 * @param subject the subject the message was published to
 * @param payload the raw message body
 * @param headers message headers (never {@code null}); includes the injected {@code traceparent}
 */
public record InboundMessage(String subject, byte[] payload, Map<String, String> headers) {}
