package io.keel.core.ports.messaging;

import java.util.Map;

/**
 * Publishes events to a subject and lets consumers subscribe to subjects (platform.yaml
 * interservice.async, ADR-0012). This is the driven+driving port; adapters (NATS JetStream today,
 * Kafka/RabbitMQ behind the same port) implement durable, at-least-once delivery and carry the
 * caller's trace context across the broker so a consumer continues the publisher's trace.
 */
public interface MessageBus extends AutoCloseable {

  /**
   * Publish {@code payload} to {@code subject}, merging {@code headers} and injecting the current
   * trace context so a subscriber can continue the trace.
   *
   * @param subject the subject to publish to
   * @param payload the raw message body
   * @param headers caller headers to carry alongside the injected trace context (may be empty)
   */
  void publish(String subject, byte[] payload, Map<String, String> headers);

  /** Publish with no caller headers (the trace context is still injected). */
  default void publish(String subject, byte[] payload) {
    publish(subject, payload, Map.of());
  }

  /**
   * Register {@code handler} to receive messages published to {@code subject} via a durable,
   * explicit-ack consumer. Each delivery runs within the publisher's extracted trace context.
   *
   * @param subject the subject to subscribe to
   * @param handler the consumer invoked per delivered message
   */
  void subscribe(String subject, MessageHandler handler);

  /** Release broker resources (called at shutdown). */
  @Override
  void close();
}
