package io.keel.core.adapters.messaging;

import io.keel.core.ports.messaging.InboundMessage;
import io.keel.core.ports.messaging.MessageBus;
import io.keel.core.ports.messaging.MessageHandler;
import io.nats.client.Connection;
import io.nats.client.Dispatcher;
import io.nats.client.JetStream;
import io.nats.client.JetStreamApiException;
import io.nats.client.JetStreamManagement;
import io.nats.client.Message;
import io.nats.client.Nats;
import io.nats.client.PushSubscribeOptions;
import io.nats.client.api.AckPolicy;
import io.nats.client.api.ConsumerConfiguration;
import io.nats.client.api.StreamConfiguration;
import io.nats.client.impl.Headers;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapPropagator;
import io.opentelemetry.context.propagation.TextMapSetter;
import java.io.IOException;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A {@link MessageBus} backed by NATS JetStream for durable, explicit-ack, at-least-once delivery
 * (ADR-0012, epic #419 v0.6 parity). Implements the Python vertical's {@code NatsMessageBus} model:
 *
 * <ul>
 *   <li>On publish, the current W3C trace context is injected into the message headers so a
 *       subscriber continues the publisher's trace across the broker.
 *   <li>On consume, the context is extracted and made current around the handler, then the message
 *       is ack'd on success.
 *   <li>On handler failure the message is nak'd (redelivered) until {@code maxDeliver}, after which
 *       it is term'd (dead-lettered) and logged at error, so a poison message neither loops forever
 *       nor is dropped silently.
 * </ul>
 *
 * <p>Delivery uses a durable, explicit-ack push consumer; {@code ackWait} must exceed the
 * worst-case handler latency or the server redelivers a still-in-flight message and processes it
 * twice.
 */
public final class NatsMessageBus implements MessageBus {

  private static final Logger log = LoggerFactory.getLogger(NatsMessageBus.class);

  // JetStream durable names allow only [A-Za-z0-9_-]; derive a stable one per subject.
  private static final Pattern DURABLE_UNSAFE = Pattern.compile("[^A-Za-z0-9_]");

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
  private final String stream;
  private final List<String> subjects;
  private final TextMapPropagator propagator;
  private final int maxDeliver;
  private final Duration ackWait;
  private final int maxAckPending;

  private Connection connection;
  private JetStream jetStream;
  private Dispatcher dispatcher;

  /**
   * Configure the server URL, the JetStream stream/subjects, the trace propagator, and the delivery
   * policy.
   *
   * @param url the NATS server URL
   * @param stream the JetStream stream name to ensure/reconcile
   * @param subjects the subjects the stream captures
   * @param openTelemetry source of the W3C text-map propagator used to carry trace context
   * @param maxDeliver redelivery cap before a message is dead-lettered (term'd)
   * @param ackWait server wait for an ack before redelivery; must exceed handler latency
   * @param maxAckPending bound on unacked in-flight messages
   */
  public NatsMessageBus(
      String url,
      String stream,
      List<String> subjects,
      OpenTelemetry openTelemetry,
      int maxDeliver,
      Duration ackWait,
      int maxAckPending) {
    this.url = url;
    this.stream = stream;
    this.subjects = List.copyOf(subjects);
    this.propagator = openTelemetry.getPropagators().getTextMapPropagator();
    this.maxDeliver = maxDeliver;
    this.ackWait = ackWait;
    this.maxAckPending = maxAckPending;
  }

  /** Configure with the default delivery policy (maxDeliver 5, ackWait 30s, maxAckPending 256). */
  public NatsMessageBus(
      String url, String stream, List<String> subjects, OpenTelemetry openTelemetry) {
    this(url, stream, subjects, openTelemetry, 5, Duration.ofSeconds(30), 256);
  }

  /**
   * Connect and ensure the JetStream stream exists for the configured subjects. Idempotent and
   * synchronized: {@code publish}/{@code subscribe} call it on first use, so the bean does not open
   * a socket merely by being wired into a context (the application still starts when the broker is
   * unreachable; the failure surfaces on first use, matching how the OIDC decoder connects lazily).
   */
  public synchronized void connect() {
    if (jetStream != null) {
      return;
    }
    try {
      this.connection = Nats.connect(url);
      this.jetStream = connection.jetStream();
      JetStreamManagement management = connection.jetStreamManagement();
      StreamConfiguration config =
          StreamConfiguration.builder().name(stream).subjects(subjects).build();
      try {
        management.addStream(config);
      } catch (JetStreamApiException alreadyExists) {
        // Stream already exists; reconcile its subjects (parity with the Python adapter).
        management.updateStream(config);
      }
    } catch (IOException | JetStreamApiException e) {
      throw new IllegalStateException("failed to connect to NATS JetStream at " + url, e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("interrupted connecting to NATS JetStream at " + url, e);
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
    Headers natsHeaders = new Headers();
    carrier.forEach((key, value) -> natsHeaders.put(key, value));
    try {
      jetStream.publish(subject, natsHeaders, payload);
    } catch (IOException | JetStreamApiException e) {
      throw new IllegalStateException("failed to publish to " + subject, e);
    }
  }

  @Override
  public void subscribe(String subject, MessageHandler handler) {
    connect();
    String durable = "keel_" + DURABLE_UNSAFE.matcher(subject).replaceAll("_");
    ConsumerConfiguration consumer =
        ConsumerConfiguration.builder()
            .ackPolicy(AckPolicy.Explicit)
            .maxDeliver(maxDeliver)
            .ackWait(ackWait)
            .maxAckPending(maxAckPending)
            .build();
    PushSubscribeOptions options =
        PushSubscribeOptions.builder().durable(durable).configuration(consumer).build();
    if (dispatcher == null) {
      dispatcher = connection.createDispatcher();
    }
    try {
      jetStream.subscribe(
          subject, dispatcher, message -> dispatch(message, handler), false, options);
    } catch (IOException | JetStreamApiException e) {
      throw new IllegalStateException("failed to subscribe to " + subject, e);
    }
  }

  /**
   * Run {@code handler} with the extracted trace context; ack on success, nak/term on failure. One
   * bad handler must not kill the subscription, so every exception is caught and turned into a
   * control-plane decision. Package-private so the ack/nak/term policy is unit-testable without a
   * broker.
   */
  void dispatch(Message message, MessageHandler handler) {
    Map<String, String> headers = toMap(message.getHeaders());
    InboundMessage inbound = new InboundMessage(message.getSubject(), message.getData(), headers);
    Context extracted = propagator.extract(Context.current(), headers, GETTER);
    try (Scope ignored = extracted.makeCurrent()) {
      handler.handle(inbound);
      control(message::ack, "ack", message.getSubject());
    } catch (Exception handlerFailure) {
      // Redeliver until the cap, then terminate. Always log the control-plane decision: a terminate
      // dead-letters the message (dropped from redelivery), which must never be silent. The handler
      // still owns its own domain error logging/tracing.
      long numDelivered = message.metaData().deliveredCount();
      if (numDelivered >= maxDeliver) {
        log.error(
            "message terminated after exhausting delivery attempts: subject={} stream={} numDelivered={} maxDeliver={}",
            message.getSubject(),
            stream,
            numDelivered,
            maxDeliver,
            handlerFailure);
        control(message::term, "term", message.getSubject());
      } else {
        log.warn(
            "message handler failed; scheduling redelivery: subject={} numDelivered={}",
            message.getSubject(),
            numDelivered,
            handlerFailure);
        control(message::nak, "nak", message.getSubject());
      }
    }
  }

  @Override
  public void close() {
    if (connection != null) {
      try {
        connection.close();
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
      connection = null;
      jetStream = null;
      dispatcher = null;
    }
  }

  /**
   * Run an ack/nak/term call, logging (not raising) a control-plane failure so it is diagnosable.
   */
  private static void control(AckOperation operation, String name, String subject) {
    try {
      operation.run();
    } catch (Exception e) {
      // A failed ack/nak/term would otherwise vanish; surface it so redelivery or
      // duplicate-processing anomalies are diagnosable.
      log.error("jetstream control call failed: op={} subject={}", name, subject, e);
    }
  }

  private static Map<String, String> toMap(Headers headers) {
    if (headers == null) {
      return Map.of();
    }
    Map<String, String> map = new HashMap<>();
    for (String key : headers.keySet()) {
      String value = headers.getFirst(key);
      if (value != null) {
        map.put(key, value);
      }
    }
    return map;
  }

  @FunctionalInterface
  private interface AckOperation {
    void run() throws Exception;
  }
}
