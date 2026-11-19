package io.keel.core.adapters.messaging;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.propagation.ContextPropagators;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.header.internals.RecordHeaders;
import org.apache.kafka.common.record.TimestampType;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * Exercises the Kafka per-record commit/retry/dead-letter policy and trace-context extraction
 * without a broker (ADR-0025, the parallel of the NATS and RabbitMQ dispatch tests and the Go
 * reference's {@code kafka_test.go}). The poison path (re-produce to {@code <topic>.retry} below
 * the cap, dead-letter to {@code <topic>.dlq} at the cap), the critical
 * dead-letter-on-the-fifth-attempt guarantee, and the preserve-on-produce-failure policy are the
 * safety-critical branches, so they are verified deterministically here rather than only through
 * the broker-gated integration test.
 */
class KafkaMessageBusDispatchTest {

  private static final OpenTelemetry OTEL =
      OpenTelemetry.propagating(ContextPropagators.create(W3CTraceContextPropagator.getInstance()));

  private static final String BASE_TOPIC = "keel_test_events";
  private static final String DELIVERY_COUNT_HEADER = "keel-delivery-count";

  /** A bus with maxDeliver 5 and dummy brokers; it never connects (dispatch takes the sink). */
  private static KafkaMessageBus bus() {
    return new KafkaMessageBus(
        List.of("unused:9092"), List.of("keel.test.events"), "keel", "", OTEL, 5);
  }

  /**
   * Build a base-topic record whose {@code keel-delivery-count} header encodes a 1-based
   * numDelivered (count = numDelivered - 1), matching the other verticals' convention; numDelivered
   * 1 omits the header entirely (the first delivery).
   */
  private static ConsumerRecord<byte[], byte[]> record(
      String topic, int numDelivered, Map<String, String> extraHeaders) {
    RecordHeaders headers = new RecordHeaders();
    extraHeaders.forEach((k, v) -> headers.add(k, v.getBytes(UTF_8)));
    if (numDelivered > 1) {
      headers.add(DELIVERY_COUNT_HEADER, Integer.toString(numDelivered - 1).getBytes(UTF_8));
    }
    return new ConsumerRecord<>(
        topic,
        0,
        0L,
        0L,
        TimestampType.CREATE_TIME,
        -1,
        -1,
        null,
        "payload".getBytes(UTF_8),
        headers,
        Optional.empty());
  }

  /** A fake sink recording produces and commits without a live client (the Go fakeSink analog). */
  private static final class FakeSink implements KafkaMessageBus.RecordSink {
    final List<ProducerRecord<byte[], byte[]>> produced = new ArrayList<>();
    int commits;
    RuntimeException produceError;
    RuntimeException commitError;

    @Override
    public void produce(ProducerRecord<byte[], byte[]> rec) {
      if (produceError != null) {
        throw produceError;
      }
      produced.add(rec);
    }

    @Override
    public void commit(ConsumerRecord<byte[], byte[]> rec) {
      if (commitError != null) {
        throw commitError;
      }
      commits++;
    }

    ProducerRecord<byte[], byte[]> lastProducedTo(String suffix) {
      ProducerRecord<byte[], byte[]> last = null;
      for (ProducerRecord<byte[], byte[]> r : produced) {
        if (r.topic().endsWith(suffix)) {
          last = r;
        }
      }
      return last;
    }
  }

  private static int deliveryCount(ProducerRecord<byte[], byte[]> rec) {
    Header header = rec.headers().lastHeader(DELIVERY_COUNT_HEADER);
    return header == null ? -1 : Integer.parseInt(new String(header.value(), UTF_8));
  }

  // --- Pure disposition policy (parity with the other four verticals), broker-free -------------

  @Test
  void dispositionAcksOnSuccessRegardlessOfCount() {
    assertEquals(KafkaMessageBus.Disposition.ACK, KafkaMessageBus.disposition(true, 1, 5));
    assertEquals(KafkaMessageBus.Disposition.ACK, KafkaMessageBus.disposition(true, 99, 5));
  }

  @Test
  void dispositionRetriesOnFailureBelowMaxDeliver() {
    assertEquals(KafkaMessageBus.Disposition.RETRY, KafkaMessageBus.disposition(false, 1, 5));
    assertEquals(KafkaMessageBus.Disposition.RETRY, KafkaMessageBus.disposition(false, 4, 5));
  }

  @Test
  void dispositionDeadLettersAtTheCap() {
    assertEquals(KafkaMessageBus.Disposition.DEAD_LETTER, KafkaMessageBus.disposition(false, 5, 5));
    assertEquals(KafkaMessageBus.Disposition.DEAD_LETTER, KafkaMessageBus.disposition(false, 6, 5));
  }

  // --- Dispatch over a fake sink ----------------------------------------------------------------

  @Test
  void commitsOnSuccess() {
    FakeSink sink = new FakeSink();

    bus().dispatch(sink, record(BASE_TOPIC, 1, Map.of()), inbound -> {});

    assertEquals(1, sink.commits, "a successful handler commits exactly once");
    assertTrue(sink.produced.isEmpty(), "success produces no retry or dead-letter record");
  }

  @Test
  void retriesBelowMaxDeliverAndCommitsOriginal() {
    FakeSink sink = new FakeSink();

    bus()
        .dispatch(
            sink,
            record(BASE_TOPIC, 1, Map.of()), // numDelivered 1, below the default cap of 5
            inbound -> {
              throw new IllegalStateException("transient");
            });

    ProducerRecord<byte[], byte[]> retry = sink.lastProducedTo(".retry");
    assertNotNull(retry, "a failed record below the cap is re-produced to the retry topic");
    assertEquals(BASE_TOPIC + ".retry", retry.topic());
    // The header stores the just-attempted numDelivered (1 after the first failure); the next read
    // adds one, so the second delivery sees numDelivered == 2. Matches the Go reference's
    // assertion.
    assertEquals(
        1, deliveryCount(retry), "the retried record carries the incremented delivery count");
    assertEquals(
        1,
        sink.commits,
        "the original offset is committed after the retry produce so the partition is not blocked");
    assertNull(sink.lastProducedTo(".dlq"), "below the cap nothing is dead-lettered");
  }

  /** The required dead-letter-at-cap case: the 5th attempt (numDelivered == maxDeliver). */
  @Test
  void deadLettersAtMaxDeliverAndCommitsOriginal() {
    FakeSink sink = new FakeSink();

    bus()
        .dispatch(
            sink,
            record(BASE_TOPIC, 5, Map.of()), // numDelivered 5 == default maxDeliver -> dead-letter
            inbound -> {
              throw new IllegalStateException("poison");
            });

    ProducerRecord<byte[], byte[]> dlq = sink.lastProducedTo(".dlq");
    assertNotNull(dlq, "at the cap the record is produced to the dead-letter topic");
    assertEquals(BASE_TOPIC + ".dlq", dlq.topic());
    assertEquals(
        "payload", new String(dlq.value(), UTF_8), "the dead-lettered payload is the original");
    assertEquals(1, sink.commits, "the original offset is committed after dead-lettering");
    assertNull(sink.lastProducedTo(".retry"), "at the cap the record is not retried");
  }

  /**
   * The critical guarantee: feed each retry produce back into dispatch (simulating the consumer
   * group redelivering the retried record) and prove the record is retried exactly four times and
   * dead-lettered on the FIFTH attempt, never looping forever nor dropped early.
   */
  @Test
  void repeatedlyFailingRecordDeadLettersAtTheFifthAttempt() {
    KafkaMessageBus bus = bus();
    ConsumerRecord<byte[], byte[]> current = record(BASE_TOPIC, 1, Map.of());

    int attempts = 0;
    while (attempts < 100) {
      attempts++;
      FakeSink sink = new FakeSink();
      bus.dispatch(
          sink,
          current,
          inbound -> {
            throw new IllegalStateException("always fails");
          });

      if (sink.lastProducedTo(".dlq") != null) {
        break; // dead-lettered: the loop terminates
      }
      ProducerRecord<byte[], byte[]> retry = sink.lastProducedTo(".retry");
      assertNotNull(
          retry, "attempt " + attempts + " produced neither a retry nor a dead-letter record");
      // The consumer group redelivers the retried record: it becomes the next attempt's input,
      // carrying forward the incremented delivery-count header.
      RecordHeaders headers = new RecordHeaders();
      for (Header h : retry.headers()) {
        headers.add(h.key(), h.value());
      }
      current =
          new ConsumerRecord<>(
              BASE_TOPIC,
              0,
              0L,
              0L,
              TimestampType.CREATE_TIME,
              -1,
              -1,
              null,
              retry.value(),
              headers,
              Optional.empty());
    }

    assertEquals(
        5,
        attempts,
        "the record must dead-letter on exactly the 5th attempt (4 retries then dead-letter)");
  }

  @Test
  void retryProduceFailureLeavesOffsetUncommitted() {
    FakeSink sink = new FakeSink();
    // The retry produce fails; below the cap the record has no home, so the offset must stay
    // uncommitted for redelivery rather than being lost.
    sink.produceError = new IllegalStateException("broker down");

    bus()
        .dispatch(
            sink,
            record(BASE_TOPIC, 1, Map.of()),
            inbound -> {
              throw new IllegalStateException("transient");
            });

    assertEquals(0, sink.commits, "the offset must not be committed when the retry produce fails");
  }

  @Test
  void deadLetterProduceFailureLeavesOffsetUncommitted() {
    FakeSink sink = new FakeSink();
    // The dead-letter produce fails at the cap; the offset must stay uncommitted so the record is
    // redelivered rather than silently dropped.
    sink.produceError = new IllegalStateException("broker down");

    bus()
        .dispatch(
            sink,
            record(BASE_TOPIC, 5, Map.of()),
            inbound -> {
              throw new IllegalStateException("poison");
            });

    assertEquals(
        0, sink.commits, "the offset must not be committed when the dead-letter produce fails");
  }

  @Test
  void deadLetteredRecordIsLoggedNotDroppedSilently() {
    FakeSink sink = new FakeSink();
    Logger logger = (Logger) LoggerFactory.getLogger(KafkaMessageBus.class);
    ListAppender<ILoggingEvent> appender = new ListAppender<>();
    appender.start();
    logger.addAppender(appender);
    try {
      bus()
          .dispatch(
              sink,
              record(BASE_TOPIC, 5, Map.of()),
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
    assertTrue(terminatedLogged, "a dead-lettered record must be logged at error");
  }

  @Test
  void commitFailureIsLoggedNotRaised() {
    FakeSink sink = new FakeSink();
    sink.commitError = new IllegalStateException("commit failed");

    // A failed commit must be swallowed (logged), never propagate out of dispatch and kill the
    // loop.
    bus().dispatch(sink, record(BASE_TOPIC, 1, Map.of()), inbound -> {});
  }

  @Test
  void retriedRecordRoutesToTheBaseHandlerSubject() {
    FakeSink sink = new FakeSink();
    AtomicReference<String> seen = new AtomicReference<>();

    // A record arriving on <topic>.retry is reported to the handler under the base subject, so the
    // retry loop converges on the same consumer.
    bus()
        .dispatch(
            sink,
            record(BASE_TOPIC + ".retry", 1, Map.of()),
            inbound -> seen.set(inbound.subject()));

    assertEquals(
        BASE_TOPIC, seen.get(), "the handler must see the base subject, not the .retry topic");
  }

  @Test
  void setsSubjectFromKeelSubjectHeaderElseTopic() {
    // The topic is a lossy transform of the subject (keel.test.events -> keel_test_events), so the
    // delivered subject must come from the keel-subject header to equal the published subject.
    AtomicReference<String> fromHeader = new AtomicReference<>();
    bus()
        .dispatch(
            new FakeSink(),
            record(BASE_TOPIC, 1, Map.of("keel-subject", "keel.test.events")),
            inbound -> fromHeader.set(inbound.subject()));
    assertEquals(
        "keel.test.events",
        fromHeader.get(),
        "the delivered subject comes from the keel-subject header, not the sanitized topic");

    // Absent the header, the subject falls back to the base topic name.
    AtomicReference<String> fallback = new AtomicReference<>();
    bus()
        .dispatch(
            new FakeSink(),
            record(BASE_TOPIC, 1, Map.of()),
            inbound -> fallback.set(inbound.subject()));
    assertEquals(
        BASE_TOPIC,
        fallback.get(),
        "with no keel-subject header the subject falls back to the topic");
  }

  @Test
  void dlqTopicOverrideIsUsedAtTheCap() {
    FakeSink sink = new FakeSink();
    KafkaMessageBus bus =
        new KafkaMessageBus(
            List.of("unused:9092"),
            List.of("keel.test.events"),
            "keel",
            "keel.deadletters",
            OTEL,
            5);

    bus.dispatch(
        sink,
        record(BASE_TOPIC, 5, Map.of()),
        inbound -> {
          throw new IllegalStateException("poison");
        });

    ProducerRecord<byte[], byte[]> dead = sink.produced.get(sink.produced.size() - 1);
    assertEquals("keel.deadletters", dead.topic(), "the shared DLQ override replaces <topic>.dlq");
  }

  @Test
  void extractsTraceContextAroundTheHandler() {
    FakeSink sink = new FakeSink();
    String traceId = "0af7651916cd43dd8448eb211c80319c";
    AtomicReference<String> seenTraceId = new AtomicReference<>();
    AtomicReference<Map<String, String>> seenHeaders = new AtomicReference<>();

    bus()
        .dispatch(
            sink,
            record(BASE_TOPIC, 1, Map.of("traceparent", "00-" + traceId + "-b7ad6b7169203331-01")),
            inbound -> {
              seenTraceId.set(Span.current().getSpanContext().getTraceId());
              seenHeaders.set(inbound.headers());
            });

    assertEquals(
        traceId, seenTraceId.get(), "the handler must run within the publisher's trace context");
    assertEquals("00-" + traceId + "-b7ad6b7169203331-01", seenHeaders.get().get("traceparent"));
    assertFalse(seenHeaders.get().isEmpty());
  }

  @Test
  void topicNameSanitizesSubject() {
    assertEquals("keel", KafkaMessageBus.topicName("keel"));
    assertEquals("keel_test_events", KafkaMessageBus.topicName("keel.test.events"));
    assertEquals("keel_test__", KafkaMessageBus.topicName("keel.test.>"));
  }

  /**
   * A produce failure must never echo the bootstrap brokers (which, with SASL, carry credentials)
   * into the surfaced exception or its chained stack trace, so no credential lands in the log. Uses
   * a bounded {@code max.block.ms} against an unreachable but valid-format broker so publish fails
   * fast without a live broker (the parallel of the RabbitMQ connect-leak test).
   */
  @Test
  void publishFailureDoesNotLeakBrokers() {
    KafkaMessageBus bus =
        new KafkaMessageBus(
            List.of("leakhost-secret:9092"),
            List.of("keel.test.events"),
            "keel",
            "",
            OTEL,
            5,
            Map.of("max.block.ms", "1000", "request.timeout.ms", "1000"));
    try {
      IllegalStateException thrown =
          assertThrows(
              IllegalStateException.class,
              () -> bus.publish("keel.test.events", "x".getBytes(UTF_8), Map.of()));

      StringWriter trace = new StringWriter();
      thrown.printStackTrace(new PrintWriter(trace));
      String rendered = thrown.getMessage() + "\n" + trace;
      assertFalse(
          rendered.contains("leakhost-secret"),
          "a produce failure must not echo the bootstrap brokers");
    } finally {
      bus.close();
    }
  }
}
