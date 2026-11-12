package io.keel.core.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.keel.core.logging.Redactor;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Proves the OTLP span-export path is scrubbed of secrets by {@link RedactingSpanExporter}, reusing
 * the same {@link Redactor} families as the JSON log sink (parity epic #419). A span carrying a
 * secret-family attribute key and a pattern secret inside a string value is driven through a real
 * SDK tracer provider whose simple span processor exports into an {@link InMemorySpanExporter}; the
 * decorator wraps that in-memory exporter.
 *
 * <p>Non-vacuous: {@link #withoutDecoratorSecretsLeakRaw()} is the negative control - wiring the
 * in-memory exporter directly (no decorator) exports the secret raw, so every redaction assertion
 * in {@link #redactsSecretKeyAndPatternValuesOnExport()} fails the moment the decorator is removed.
 */
class RedactingSpanExporterTest {

  private static final String BEARER = "Bearer abcdef0123456789secrettoken";
  private static final AttributeKey<String> PASSWORD = AttributeKey.stringKey("password");
  private static final AttributeKey<String> USER = AttributeKey.stringKey("user");
  private static final AttributeKey<String> NOTE = AttributeKey.stringKey("note");
  private static final AttributeKey<String> CARD = AttributeKey.stringKey("card");
  private static final AttributeKey<Long> STATUS = AttributeKey.longKey("http.status_code");
  private static final AttributeKey<Boolean> CACHE_HIT = AttributeKey.booleanKey("cache.hit");
  private static final AttributeKey<List<String>> TAGS = AttributeKey.stringArrayKey("tags");

  @Test
  void redactsSecretKeyAndPatternValuesOnExport() {
    InMemorySpanExporter collected = InMemorySpanExporter.create();
    Attributes attributes = exportSpan(new RedactingSpanExporter(collected), collected);

    // Secret-family key redacted wholesale.
    assertEquals(Redactor.REDACTED, attributes.get(PASSWORD));
    // Pattern secret inside a non-secret-keyed string value scrubbed in place.
    assertEquals("token=" + Redactor.REDACTED, attributes.get(NOTE));
    assertFalse(attributes.get(NOTE).contains(BEARER), "BEARER leaked in note attribute");
    // Luhn-valid card scrubbed.
    assertEquals(Redactor.REDACTED, attributes.get(CARD));
    // Innocuous value passes through untouched.
    assertEquals("alice", attributes.get(USER));
    // Each element of a string-array value is scrubbed; the clean element survives.
    assertEquals(List.of("ok", "token=" + Redactor.REDACTED), attributes.get(TAGS));
    // Non-string typed attributes cannot carry a textual secret and pass through with their type
    // intact (not stringified by the rewrite).
    assertEquals(200L, attributes.get(STATUS));
    assertEquals(Boolean.TRUE, attributes.get(CACHE_HIT));
  }

  @Test
  void withoutDecoratorSecretsLeakRaw() {
    // Negative control: identical span, exporter NOT wrapped. The secrets survive, proving the
    // redaction above is produced by the decorator and not by the SDK or the assertions.
    InMemorySpanExporter collected = InMemorySpanExporter.create();
    Attributes attributes = exportSpan(collected, collected);

    assertEquals("hunter2", attributes.get(PASSWORD));
    assertTrue(attributes.get(NOTE).contains(BEARER), "control: BEARER should be present raw");
    assertEquals("4242 4242 4242 4242", attributes.get(CARD));
  }

  private static Attributes exportSpan(SpanExporter exporter, InMemorySpanExporter collected) {
    // SimpleSpanProcessor exports synchronously on span end, so the collected items are read before
    // the provider is shut down - shutdown would propagate to the in-memory exporter and clear
    // them.
    SdkTracerProvider provider =
        SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build();
    try {
      Tracer tracer = provider.get("redaction-test");
      Span span = tracer.spanBuilder("operation").startSpan();
      span.setAttribute(PASSWORD, "hunter2");
      span.setAttribute(NOTE, "token=" + BEARER);
      span.setAttribute(CARD, "4242 4242 4242 4242");
      span.setAttribute(USER, "alice");
      span.setAttribute(TAGS, List.of("ok", "token=" + BEARER));
      span.setAttribute(STATUS, 200L);
      span.setAttribute(CACHE_HIT, true);
      span.end();

      List<SpanData> spans = collected.getFinishedSpanItems();
      assertEquals(1, spans.size(), "exactly one span should be exported");
      return spans.get(0).getAttributes();
    } finally {
      provider.close();
    }
  }
}
