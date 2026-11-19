package io.keel.core.adapters.messaging;

import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.CancelCallback;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import com.rabbitmq.client.DeliverCallback;
import com.rabbitmq.client.Delivery;
import com.rabbitmq.client.Envelope;
import io.keel.core.ports.messaging.InboundMessage;
import io.keel.core.ports.messaging.MessageBus;
import io.keel.core.ports.messaging.MessageHandler;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapPropagator;
import io.opentelemetry.context.propagation.TextMapSetter;
import java.io.IOException;
import java.net.URISyntaxException;
import java.security.KeyManagementException;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A {@link MessageBus} backed by RabbitMQ (AMQP 0-9-1) for durable, manual-ack, at-least-once
 * delivery (ADR-0025). Delivers the identical contract to the NATS JetStream adapter, mapped onto
 * RabbitMQ primitives:
 *
 * <ul>
 *   <li>A durable <b>topic exchange</b> ({@code keel}); {@code publish} uses the subject as the
 *       routing key, injecting the current W3C trace context into the AMQP headers so a subscriber
 *       continues the publisher's trace across the broker.
 *   <li>A durable <b>queue</b> ({@code keel}) is bound to the subscribed subject and consumed with
 *       manual ack; on consume the context is extracted and made current around the handler.
 *   <li>On handler success the delivery is {@code basic.ack}'d. On handler failure it is {@code
 *       basic.nack(requeue=true)} until the delivery count reaches {@code maxDeliver}, after which
 *       it is published to the <b>dead-letter exchange</b> ({@code keel.dlx}) and the original
 *       {@code basic.ack}'d (dead-lettered), always logged at error so a poison message neither
 *       loops forever nor is dropped silently.
 * </ul>
 *
 * <p>The delivery count is read from the AMQP {@code x-delivery-count} header (quorum queues
 * increment it on every redelivery) with a {@code keel-delivery-count} header as the portable
 * fallback; the primary queue is declared as a quorum queue so the count is authoritative. A
 * control-plane failure (a failed ack/nack) is logged, never raised, so one bad delivery cannot
 * kill the subscription.
 */
public final class RabbitMqMessageBus implements MessageBus {

  private static final Logger log = LoggerFactory.getLogger(RabbitMqMessageBus.class);

  private static final String DELIVERY_COUNT_HEADER = "x-delivery-count";
  private static final String FALLBACK_DELIVERY_COUNT_HEADER = "keel-delivery-count";

  private static final TextMapSetter<Map<String, String>> SETTER = Map::put;

  private static final TextMapGetter<Map<String, String>> GETTER =
      new TextMapGetter<>() {
        @Override
        public Iterable<String> keys(Map<String, String> carrier) {
          return carrier.keySet();
        }

        @Override
        public String get(Map<String, String> carrier, String key) {
          return carrier == null ? null : carrier.get(key);
        }
      };

  private final String url;
  private final String exchange;
  private final String queue;
  private final String deadLetterExchange;
  private final List<String> subjects;
  private final TextMapPropagator propagator;
  private final int maxDeliver;
  private final int prefetch;

  private Connection connection;
  private Channel consumeChannel;
  private Channel publishChannel;

  /**
   * Configure the broker URL, the exchange/queue/dead-letter-exchange, the trace propagator, and
   * the delivery policy.
   *
   * @param url the RabbitMQ (AMQP) connection URL
   * @param exchange the durable topic exchange to publish to and bind the queue against
   * @param queue the durable quorum queue that captures the subscribed subjects
   * @param deadLetterExchange the exchange a message is published to once the delivery cap is hit
   * @param subjects the default subjects (routing keys) the queue is bound to at connect
   * @param openTelemetry source of the W3C text-map propagator used to carry trace context
   * @param maxDeliver redelivery cap before a message is dead-lettered
   * @param prefetch the consumer prefetch (basic.qos) bound on unacked in-flight messages
   */
  public RabbitMqMessageBus(
      String url,
      String exchange,
      String queue,
      String deadLetterExchange,
      List<String> subjects,
      OpenTelemetry openTelemetry,
      int maxDeliver,
      int prefetch) {
    this.url = url;
    this.exchange = exchange;
    this.queue = queue;
    this.deadLetterExchange = deadLetterExchange;
    this.subjects = List.copyOf(subjects);
    this.propagator = openTelemetry.getPropagators().getTextMapPropagator();
    this.maxDeliver = maxDeliver;
    this.prefetch = prefetch;
  }

  /** Configure with the default delivery policy (maxDeliver 5, prefetch 256). */
  public RabbitMqMessageBus(
      String url,
      String exchange,
      String queue,
      String deadLetterExchange,
      List<String> subjects,
      OpenTelemetry openTelemetry) {
    this(url, exchange, queue, deadLetterExchange, subjects, openTelemetry, 5, 256);
  }

  /**
   * Configure with the default subjects ({@code keel.#}) and delivery policy. Retained so callers
   * that do not override the subject binding (and the broker-free dispatch tests) stay terse.
   */
  public RabbitMqMessageBus(
      String url,
      String exchange,
      String queue,
      String deadLetterExchange,
      OpenTelemetry openTelemetry) {
    this(url, exchange, queue, deadLetterExchange, List.of("keel.#"), openTelemetry, 5, 256);
  }

  /**
   * Connect and ensure the exchange, dead-letter exchange, and durable queue exist, binding the
   * configured default subjects (default {@code keel.#}) so the queue captures the contract's
   * subjects at connect, parallel to the other verticals. Idempotent and synchronized: {@code
   * publish}/{@code subscribe} call it on first use, so the bean does not open a socket merely by
   * being wired into a context (the application still starts when the broker is unreachable; the
   * failure surfaces on first use, matching how the NATS bus connects lazily).
   */
  public synchronized void connect() {
    if (connection != null) {
      return;
    }
    try {
      ConnectionFactory factory = new ConnectionFactory();
      factory.setUri(url);
      this.connection = factory.newConnection();
      this.consumeChannel = connection.createChannel();
      this.publishChannel = connection.createChannel();
      consumeChannel.exchangeDeclare(exchange, "topic", true);
      consumeChannel.exchangeDeclare(deadLetterExchange, "topic", true);
      // Quorum queue so x-delivery-count is authoritative on every redelivery (ADR-0025); durable,
      // non-exclusive, non-auto-delete as quorum queues require.
      consumeChannel.queueDeclare(queue, true, false, false, Map.of("x-queue-type", "quorum"));
      consumeChannel.basicQos(prefetch);
      // Bind the configured default subjects (default keel.#) at connect, parallel to the other
      // verticals; subscribe still binds its specific subject on top.
      for (String subject : subjects) {
        consumeChannel.queueBind(queue, exchange, subject);
      }
    } catch (URISyntaxException | NoSuchAlgorithmException | KeyManagementException e) {
      // The URL carries credentials (amqp://user:pass@host); never echo it into an exception that
      // Spring logs with the stack trace. The cause is chained for diagnosis without the secret.
      throw new IllegalStateException("invalid RabbitMQ URL", e);
    } catch (IOException e) {
      throw new IllegalStateException("failed to connect to RabbitMQ", e);
    } catch (TimeoutException e) {
      throw new IllegalStateException("timed out connecting to RabbitMQ", e);
    }
  }

  @Override
  public void publish(String subject, byte[] payload, Map<String, String> headers) {
    connect();
    Map<String, String> carrier = new HashMap<>();
    if (headers != null) {
      carrier.putAll(headers);
    }
    propagator.inject(Context.current(), carrier, SETTER);
    AMQP.BasicProperties properties =
        new AMQP.BasicProperties.Builder()
            .headers(new HashMap<>(carrier))
            .deliveryMode(2) // persistent, so a durable queue survives a broker restart
            .build();
    try {
      synchronized (this) {
        publishChannel.basicPublish(exchange, subject, properties, payload);
      }
    } catch (IOException e) {
      throw new IllegalStateException("failed to publish to " + subject, e);
    }
  }

  @Override
  public void subscribe(String subject, MessageHandler handler) {
    connect();
    DeliverCallback onDeliver =
        (consumerTag, delivery) -> dispatch(consumeChannel, delivery, handler);
    CancelCallback onCancel = consumerTag -> {};
    try {
      consumeChannel.queueBind(queue, exchange, subject);
      consumeChannel.basicConsume(queue, false, onDeliver, onCancel);
    } catch (IOException e) {
      throw new IllegalStateException("failed to subscribe to " + subject, e);
    }
  }

  /**
   * Run {@code handler} with the extracted trace context; ack on success, nack/dead-letter on
   * failure. One bad handler must not kill the subscription, so every exception is caught and
   * turned into a control-plane decision. Package-private so the ack/nack/dead-letter policy is
   * unit-testable without a broker.
   */
  void dispatch(Channel channel, Delivery delivery, MessageHandler handler) {
    Envelope envelope = delivery.getEnvelope();
    long deliveryTag = envelope.getDeliveryTag();
    String subject = envelope.getRoutingKey();
    AMQP.BasicProperties properties = delivery.getProperties();
    Map<String, String> headers = toMap(properties == null ? null : properties.getHeaders());
    InboundMessage inbound = new InboundMessage(subject, delivery.getBody(), headers);
    Context extracted = propagator.extract(Context.current(), headers, GETTER);

    boolean ok;
    Exception handlerFailure = null;
    try (Scope scope = extracted.makeCurrent()) {
      handler.handle(inbound);
      ok = true;
    } catch (Exception e) {
      // One bad handler must not kill the subscription, so every exception is caught and turned
      // into a control-plane decision. The handler still owns its own domain error logging/tracing.
      ok = false;
      handlerFailure = e;
    }

    long numDelivered = deliveryCount(properties);
    switch (disposition(ok, (int) numDelivered, maxDeliver)) {
      case ACK -> control(() -> channel.basicAck(deliveryTag, false), "ack", subject);
      case REDELIVER -> {
        log.warn(
            "message handler failed; scheduling redelivery: subject={} numDelivered={}",
            subject,
            numDelivered,
            handlerFailure);
        control(() -> channel.basicNack(deliveryTag, false, true), "nack", subject);
      }
      case DEAD_LETTER -> {
        // Always log the control-plane decision: a dead-letter drops the message from redelivery,
        // which must never be silent.
        log.error(
            "message terminated after exhausting delivery attempts: subject={} dlx={} numDelivered={} maxDeliver={}",
            subject,
            deadLetterExchange,
            numDelivered,
            maxDeliver,
            handlerFailure);
        control(
            () -> {
              channel.basicPublish(deadLetterExchange, subject, properties, delivery.getBody());
              channel.basicAck(deliveryTag, false);
            },
            "dead-letter",
            subject);
      }
    }
  }

  /** The fate of a delivered message, decided purely from the handler outcome + delivery count. */
  enum Disposition {
    ACK,
    REDELIVER,
    DEAD_LETTER
  }

  /**
   * Decide a message's fate from the handler outcome and delivery count. Pure, so the
   * poison-handling policy is unit-testable without a broker (parity with the other four
   * verticals): ack on success regardless of count; redeliver (nack) on failure under the cap;
   * dead-letter at or over it.
   */
  static Disposition disposition(boolean ok, int numDelivered, int maxDeliver) {
    if (ok) {
      return Disposition.ACK;
    }
    if (numDelivered >= maxDeliver) {
      return Disposition.DEAD_LETTER;
    }
    return Disposition.REDELIVER;
  }

  @Override
  public void close() {
    if (connection != null) {
      try {
        connection.close();
      } catch (IOException e) {
        log.warn("failed to close RabbitMQ connection cleanly", e);
      }
      connection = null;
      consumeChannel = null;
      publishChannel = null;
    }
  }

  /**
   * The 1-based count of delivery attempts for this message. Reads the AMQP {@code
   * x-delivery-count} header a quorum queue increments on each redelivery (0 on first delivery),
   * falling back to a portable {@code keel-delivery-count} header; absent both, this is the first
   * delivery.
   */
  private static long deliveryCount(AMQP.BasicProperties properties) {
    Map<String, Object> headers = properties == null ? null : properties.getHeaders();
    if (headers == null) {
      return 1;
    }
    Long redeliveries = asLong(headers.get(DELIVERY_COUNT_HEADER));
    if (redeliveries == null) {
      redeliveries = asLong(headers.get(FALLBACK_DELIVERY_COUNT_HEADER));
    }
    return (redeliveries == null ? 0 : redeliveries) + 1;
  }

  private static Long asLong(Object value) {
    if (value instanceof Number number) {
      return number.longValue();
    }
    if (value != null) {
      try {
        return Long.parseLong(value.toString().trim());
      } catch (NumberFormatException ignored) {
        return null;
      }
    }
    return null;
  }

  /** Run an ack/nack/dead-letter call, logging (not raising) a control-plane failure. */
  private static void control(AckOperation operation, String name, String subject) {
    try {
      operation.run();
    } catch (Exception e) {
      // A failed ack/nack/dead-letter would otherwise vanish; surface it so redelivery or
      // duplicate-processing anomalies are diagnosable.
      log.error("rabbitmq control call failed: op={} subject={}", name, subject, e);
    }
  }

  private static Map<String, String> toMap(Map<String, Object> headers) {
    if (headers == null) {
      return Map.of();
    }
    Map<String, String> map = new HashMap<>();
    headers.forEach((key, value) -> {
      if (value != null) {
        map.put(key, value.toString());
      }
    });
    return map;
  }

  @FunctionalInterface
  private interface AckOperation {
    void run() throws Exception;
  }
}
