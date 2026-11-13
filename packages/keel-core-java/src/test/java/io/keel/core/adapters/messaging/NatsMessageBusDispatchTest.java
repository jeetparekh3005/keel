package io.keel.core.adapters.messaging;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import io.nats.client.Message;
import io.nats.client.impl.Headers;
import io.nats.client.impl.NatsJetStreamMetaData;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.propagation.ContextPropagators;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * Exercises the NATS per-message ack/nak/term policy and trace-context extraction without a broker
 * (the Java analog of the Python vertical's {@code test_nats_dispatch.py}). The poison path
 * (redeliver until the cap, then dead-letter) and the control-plane failure handling are the
 * safety-critical branches, so they are verified deterministically here rather than only through
 * the broker-gated integration test.
 */
class NatsMessageBusDispatchTest {

  private static final OpenTelemetry OTEL =
      OpenTelemetry.propagating(ContextPropagators.create(W3CTraceContextPropagator.getInstance()));

  private static NatsMessageBus bus() {
    return new NatsMessageBus("nats://unused", "keel-test", List.of("keel.test.>"), OTEL);
  }

  private static Message message(long deliveredCount, Headers headers) {
    Message message = mock(Message.class);
    when(message.getSubject()).thenReturn("keel.test.events");
    when(message.getData()).thenReturn("payload".getBytes());
    when(message.getHeaders()).thenReturn(headers);
    NatsJetStreamMetaData meta = mock(NatsJetStreamMetaData.class);
    when(meta.deliveredCount()).thenReturn(deliveredCount);
    when(message.metaData()).thenReturn(meta);
    return message;
  }

  @Test
  void acksOnSuccess() {
    Message message = message(1, new Headers());

    bus().dispatch(message, inbound -> {});

    verify(message).ack();
    verify(message, never()).nak();
    verify(message, never()).term();
  }

  @Test
  void naksWhenHandlerFailsBelowMaxDeliver() {
    Message message = message(1, new Headers());

    bus()
        .dispatch(
            message,
            inbound -> {
              throw new IllegalStateException("transient");
            });

    verify(message).nak();
    verify(message, never()).ack();
    verify(message, never()).term();
  }

  @Test
  void termsWhenHandlerFailsAtMaxDeliver() {
    Message message = message(5, new Headers()); // == default maxDeliver -> dead-letter, not loop

    bus()
        .dispatch(
            message,
            inbound -> {
              throw new IllegalStateException("poison");
            });

    verify(message).term();
    verify(message, never()).ack();
    verify(message, never()).nak();
  }

  @Test
  void terminatedMessageIsLoggedNotDroppedSilently() {
    Logger logger = (Logger) LoggerFactory.getLogger(NatsMessageBus.class);
    ListAppender<ILoggingEvent> appender = new ListAppender<>();
    appender.start();
    logger.addAppender(appender);
    try {
      bus()
          .dispatch(
              message(5, new Headers()),
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
    assertTrue(terminatedLogged, "a dead-lettered (term'd) message must be logged at error");
  }

  @Test
  void controlCallFailureIsLoggedNotRaised() {
    Message message = message(1, new Headers());
    doThrow(new RuntimeException("ack failed")).when(message).ack();

    // A failed ack must be swallowed (logged), never propagate out of the dispatch callback and
    // kill the subscription.
    bus().dispatch(message, inbound -> {});

    verify(message).ack();
  }

  @Test
  void extractsTraceContextAroundTheHandler() {
    String traceId = "0af7651916cd43dd8448eb211c80319c";
    Headers headers = new Headers();
    headers.put("traceparent", "00-" + traceId + "-b7ad6b7169203331-01");
    AtomicReference<String> seenTraceId = new AtomicReference<>();
    AtomicReference<Map<String, String>> seenHeaders = new AtomicReference<>();

    bus()
        .dispatch(
            message(1, headers),
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
