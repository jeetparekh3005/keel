package io.keel.core.adapters.messaging;

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
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Verifies the RabbitMQ adapter end to end against a real broker (ADR-0025).
 *
 * <p>Runs only when {@code KEEL_MESSAGING_IT=1} is set; CI spins up a {@code rabbitmq:4} container
 * (see {@code .github/workflows/java.yml}) and the test is skipped otherwise, exactly like the NATS
 * round-trip. It gates on the single {@code KEEL_MESSAGING_IT} flag rather than on {@code
 * KEEL_RABBITMQ_URL} so the broker URLs stay out of the ambient surefire environment (all three
 * ambient would trip the fail-closed at-most-one selector in every full-context test, ADR-0025
 * section 3); it constructs the adapter directly with its own CI-container URL. It proves two
 * things across the live broker: the payload and caller headers are delivered intact, and the
 * publisher's W3C trace context is propagated so the subscriber's handler runs within the same
 * trace (the distributed-tracing guarantee the adapter exists to provide).
 */
class RabbitMqMessageBusIntegrationTest {

  // The CI container address (java.yml); rabbitmq:4 ships the default guest/guest user, usable on
  // localhost. KEEL_RABBITMQ_IT_URL overrides for a local broker; it is a non-gating var so it
  // never leaks into a bound keel.* property.
  private static final String RABBITMQ_URL =
      System.getenv().getOrDefault("KEEL_RABBITMQ_IT_URL", "amqp://guest:guest@localhost:5672");

  @Test
  @EnabledIfEnvironmentVariable(named = "KEEL_MESSAGING_IT", matches = "1")
  void roundTripsPayloadAndPropagatesTraceContext() throws Exception {
    String url = RABBITMQ_URL;

    // A real SDK so the publisher has a sampled span (a valid trace id to propagate) and the
    // adapter
    // has the W3C propagator the production OpenTelemetry bean also carries.
    SdkTracerProvider tracerProvider =
        SdkTracerProvider.builder().setSampler(Sampler.alwaysOn()).build();
    try (OpenTelemetrySdk sdk =
        OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider)
            .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
            .build()) {

      RabbitMqMessageBus bus =
          new RabbitMqMessageBus(
              url, "keel-test-java", "keel-test-java", "keel-test-java.dlx", sdk);
      bus.connect();
      try {
        AtomicReference<InboundMessage> received = new AtomicReference<>();
        AtomicReference<String> receivedTraceId = new AtomicReference<>();
        CountDownLatch delivered = new CountDownLatch(1);

        bus.subscribe(
            "keel.test.events",
            message -> {
              receivedTraceId.set(Span.current().getSpanContext().getTraceId());
              received.set(message);
              delivered.countDown();
            });

        Tracer tracer = sdk.getTracer("keel-test");
        Span span = tracer.spanBuilder("publish").startSpan();
        String publishedTraceId = span.getSpanContext().getTraceId();
        try (Scope ignored = span.makeCurrent()) {
          bus.publish(
              "keel.test.events", "hello".getBytes(StandardCharsets.UTF_8), Map.of("x-demo", "1"));
        } finally {
          span.end();
        }

        assertTrue(
            delivered.await(10, TimeUnit.SECONDS),
            "no message delivered to keel.test.events within 10s");
        InboundMessage message = received.get();
        assertEquals("keel.test.events", message.subject());
        assertEquals("hello", new String(message.payload(), StandardCharsets.UTF_8));
        assertEquals("1", message.headers().get("x-demo"), "caller header was not delivered");
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
}
