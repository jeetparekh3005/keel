package io.keel.core.adapters.messaging;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Delivery;
import com.rabbitmq.client.Envelope;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.propagation.ContextPropagators;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * Exercises the RabbitMQ per-message ack/nack/dead-letter policy and trace-context extraction
 * without a broker (ADR-0025, the parallel of {@code NatsMessageBusDispatchTest}). The poison path
 * (redeliver until the cap, then dead-letter to the DLX) and the control-plane failure handling are
 * the safety-critical branches, so they are verified deterministically here rather than only
 * through the broker-gated integration test.
 */
class RabbitMqMessageBusDispatchTest {

  private static final OpenTelemetry OTEL =
      OpenTelemetry.propagating(ContextPropagators.create(W3CTraceContextPropagator.getInstance()));

  private static final long DELIVERY_TAG = 42L;

  private static RabbitMqMessageBus bus() {
    return new RabbitMqMessageBus("amqp://unused", "keel", "keel", "keel.dlx", OTEL);
  }

  /**
   * Build a delivery whose {@code x-delivery-count} header is the number of prior redeliveries, so
   * a value of {@code maxDeliver - 1} is the final attempt that dead-letters.
   */
  private static Delivery delivery(long priorRedeliveries, Map<String, Object> extraHeaders) {
    java.util.Map<String, Object> headers = new java.util.HashMap<>();
    headers.put("x-delivery-count", priorRedeliveries);
    headers.putAll(extraHeaders);
    Envelope envelope =
        new Envelope(DELIVERY_TAG, priorRedeliveries > 0, "keel", "keel.test.events");
    AMQP.BasicProperties properties = new AMQP.BasicProperties.Builder().headers(headers).build();
    return new Delivery(envelope, properties, "payload".getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void acksOnSuccess() throws Exception {
    Channel channel = mock(Channel.class);

    bus().dispatch(channel, delivery(0, Map.of()), inbound -> {});

    verify(channel).basicAck(DELIVERY_TAG, false);
    verify(channel, never()).basicNack(anyLong(), anyBoolean(), anyBoolean());
    verify(channel, never()).basicPublish(eq("keel.dlx"), any(), any(), any());
  }

  @Test
  void naksWhenHandlerFailsBelowMaxDeliver() throws Exception {
    Channel channel = mock(Channel.class);

    bus()
        .dispatch(
            channel,
            delivery(0, Map.of()), // numDelivered == 1, below the default cap of 5
            inbound -> {
              throw new IllegalStateException("transient");
            });

    verify(channel).basicNack(DELIVERY_TAG, false, true);
    verify(channel, never()).basicAck(anyLong(), anyBoolean());
    verify(channel, never()).basicPublish(eq("keel.dlx"), any(), any(), any());
  }

  @Test
  void deadLettersWhenHandlerFailsAtMaxDeliver() throws Exception {
    Channel channel = mock(Channel.class);

    bus()
        .dispatch(
            channel,
            delivery(4, Map.of()), // numDelivered == 5 == default maxDeliver -> dead-letter
            inbound -> {
              throw new IllegalStateException("poison");
            });

    verify(channel)
        .basicPublish(
            eq("keel.dlx"), eq("keel.test.events"), any(AMQP.BasicProperties.class), any());
    verify(channel).basicAck(DELIVERY_TAG, false);
    verify(channel, never()).basicNack(anyLong(), anyBoolean(), anyBoolean());
  }

  @Test
  void deadLetteredMessageIsLoggedNotDroppedSilently() {
    Channel channel = mock(Channel.class);
    Logger logger = (Logger) LoggerFactory.getLogger(RabbitMqMessageBus.class);
    ListAppender<ILoggingEvent> appender = new ListAppender<>();
    appender.start();
    logger.addAppender(appender);
    try {
      bus()
          .dispatch(
              channel,
              delivery(4, Map.of()),
              inbound -> {
                throw new IllegalStateException("poison");
              });
    } finally {
      logger.detachAppender(appender);
    }

    boolean terminatedLogged =
        appender.list.stream()
            .anyMatch(event ->
                event.getLevel() == Level.ERROR
                    && event.getFormattedMessage().contains("terminated"));
    assertTrue(terminatedLogged, "a dead-lettered message must be logged at error");
  }

  @Test
  void controlCallFailureIsLoggedNotRaised() throws Exception {
    Channel channel = mock(Channel.class);
    doThrow(new java.io.IOException("ack failed")).when(channel).basicAck(DELIVERY_TAG, false);

    // A failed ack must be swallowed (logged), never propagate out of the deliver callback and kill
    // the subscription.
    bus().dispatch(channel, delivery(0, Map.of()), inbound -> {});

    verify(channel).basicAck(DELIVERY_TAG, false);
  }

  @Test
  void extractsTraceContextAroundTheHandler() {
    Channel channel = mock(Channel.class);
    String traceId = "0af7651916cd43dd8448eb211c80319c";
    AtomicReference<String> seenTraceId = new AtomicReference<>();
    AtomicReference<Map<String, String>> seenHeaders = new AtomicReference<>();

    bus()
        .dispatch(
            channel,
            delivery(0, Map.of("traceparent", "00-" + traceId + "-b7ad6b7169203331-01")),
            inbound -> {
              seenTraceId.set(Span.current().getSpanContext().getTraceId());
              seenHeaders.set(inbound.headers());
            });

    assertEquals(
        traceId, seenTraceId.get(), "the handler must run within the publisher's trace context");
    assertEquals("00-" + traceId + "-b7ad6b7169203331-01", seenHeaders.get().get("traceparent"));
    assertFalse(seenHeaders.get().isEmpty());
  }
}
