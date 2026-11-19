package io.keel.core.adapters.messaging;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.keel.core.ports.messaging.InboundMessage;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.samplers.Sampler;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.ByteArrayDeserializer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Verifies the Kafka adapter end to end against a real broker (ADR-0025).
 *
 * <p>Runs only when {@code KEEL_MESSAGING_IT=1} is set; CI spins up an {@code apache/kafka} KRaft
 * container (see {@code .github/workflows/java.yml}) and the test is skipped otherwise, exactly
 * like the NATS and RabbitMQ round-trips. It gates on the single {@code KEEL_MESSAGING_IT} flag
 * rather than on {@code KEEL_KAFKA_BROKERS} so the broker URLs stay out of the ambient surefire
 * environment (all three ambient would trip the fail-closed at-most-one selector in every
 * full-context test, ADR-0025 section 3); it constructs the adapter directly with its own
 * CI-container bootstrap servers. It proves two things across the live broker: the payload and
 * caller headers are delivered intact and the publisher's W3C trace context is propagated (the
 * subscriber's handler runs within the same trace), and a poison record is driven through the retry
 * topic and lands on the dead-letter topic at the cap rather than looping forever.
 */
class KafkaMessageBusIntegrationTest {

  /**
   * A fresh subject (hence topic + consumer group) per run so a rerun does not read old offsets.
   */
  private static String uniqueSubject(String prefix) {
    return prefix + "." + System.nanoTime();
  }

  // The CI container bootstrap servers (java.yml). KEEL_KAFKA_IT_BROKERS overrides for a local
  // broker; it is a non-gating var so it never leaks into a bound keel.* property.
  private static List<String> brokers() {
    String bootstrap = System.getenv().getOrDefault("KEEL_KAFKA_IT_BROKERS", "localhost:9092");
    return Arrays.stream(bootstrap.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
  }

  @Test
  @EnabledIfEnvironmentVariable(named = "KEEL_MESSAGING_IT", matches = "1")
  void roundTripsPayloadAndPropagatesTraceContext() throws Exception {
    List<String> brokers = brokers();
    String subject = uniqueSubject("keel.test.roundtrip");

    SdkTracerProvider tracerProvider =
        SdkTracerProvider.builder().setSampler(Sampler.alwaysOn()).build();
    try (OpenTelemetrySdk sdk =
        OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider)
            .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
            .build()) {

      KafkaMessageBus bus =
          new KafkaMessageBus(
              brokers, List.of(subject), KafkaMessageBus.topicName(subject), "", sdk);
      bus.connect();
      try {
        AtomicReference<InboundMessage> received = new AtomicReference<>();
        AtomicReference<String> receivedTraceId = new AtomicReference<>();
        CountDownLatch delivered = new CountDownLatch(1);

        bus.subscribe(
            subject,
            message -> {
              if (received.get() == null) {
                receivedTraceId.set(Span.current().getSpanContext().getTraceId());
                received.set(message);
                delivered.countDown();
              }
            });

        Tracer tracer = sdk.getTracer("keel-test");
        Span span = tracer.spanBuilder("publish").startSpan();
        String publishedTraceId = span.getSpanContext().getTraceId();
        try (Scope ignored = span.makeCurrent()) {
          bus.publish(subject, "hello".getBytes(UTF_8), java.util.Map.of("x-demo", "1"));
        } finally {
          span.end();
        }

        assertTrue(
            delivered.await(60, TimeUnit.SECONDS),
            "no message delivered to " + subject + " within 60s");
        InboundMessage message = received.get();
        // The subject maps to the topic through a lossy sanitization, so the delivered subject must
        // equal the published subject (carried in the keel-subject header), not the sanitized
        // topic.
        assertEquals(
            subject,
            message.subject(),
            "the delivered subject must equal the published subject, not the sanitized topic");
        assertEquals("hello", new String(message.payload(), UTF_8));
        assertEquals("1", message.headers().get("x-demo"), "caller header was not delivered");
        assertTrue(
            message.headers().containsKey("traceparent"),
            "traceparent header did not survive delivery");
        assertFalse(publishedTraceId.isEmpty(), "publisher had no sampled trace id");
        assertEquals(
            publishedTraceId,
            receivedTraceId.get(),
            "subscriber did not continue the publisher's trace context across the broker");
      } finally {
        bus.close();
      }
    }
  }

  @Test
  @EnabledIfEnvironmentVariable(named = "KEEL_MESSAGING_IT", matches = "1")
  void poisonRecordDeadLettersEndToEnd() throws Exception {
    List<String> brokers = brokers();
    String subject = uniqueSubject("keel.test.poison");
    String dlqTopic = KafkaMessageBus.topicName(subject) + ".dlq";

    SdkTracerProvider tracerProvider =
        SdkTracerProvider.builder().setSampler(Sampler.alwaysOn()).build();
    try (OpenTelemetrySdk sdk =
        OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider)
            .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
            .build()) {

      // maxDeliver 3 keeps the round-trip short; the contract is the same at 5.
      KafkaMessageBus bus =
          new KafkaMessageBus(
              brokers, List.of(subject), KafkaMessageBus.topicName(subject), "", sdk, 3);
      bus.connect();
      try {
        // A handler that always fails forces the record through retry -> retry -> dead-letter.
        bus.subscribe(
            subject,
            message -> {
              throw new IllegalStateException("poison always fails");
            });
        bus.publish(subject, "poison".getBytes(UTF_8), java.util.Map.of());

        // A separate consumer reads the dead-letter topic from the start; the poison record must
        // land there with its original payload, proving it was neither looped forever nor dropped.
        assertTrue(
            dlqContainsPayload(brokers, dlqTopic, "poison"),
            "poison record never reached the dead-letter topic " + dlqTopic);
      } finally {
        bus.close();
      }
    }
  }

  private static boolean dlqContainsPayload(List<String> brokers, String dlqTopic, String payload) {
    Properties props = new Properties();
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, String.join(",", brokers));
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "dlq-reader-" + System.nanoTime());
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
    try (KafkaConsumer<byte[], byte[]> consumer =
        new KafkaConsumer<>(props, new ByteArrayDeserializer(), new ByteArrayDeserializer())) {
      consumer.subscribe(List.of(dlqTopic));
      long deadline = System.nanoTime() + Duration.ofSeconds(90).toNanos();
      while (System.nanoTime() < deadline) {
        ConsumerRecords<byte[], byte[]> records = consumer.poll(Duration.ofMillis(500));
        for (ConsumerRecord<byte[], byte[]> record : records) {
          if (payload.equals(new String(record.value(), UTF_8))) {
            return true;
          }
        }
      }
      return false;
    }
  }
}
