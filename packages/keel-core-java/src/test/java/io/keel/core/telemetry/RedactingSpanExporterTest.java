package io.keel.core.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.keel.core.logging.Redactor;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.EventData;
import io.opentelemetry.sdk.trace.data.LinkData;
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
  void redactsEventAttributesOnExport() {
    // A secret on a span event (a manually-recorded event and a recorded-exception event) must be
    // scrubbed the same as a span attribute; events used to delegate to the raw span and leak.
    InMemorySpanExporter collected = InMemorySpanExporter.create();
    SdkTracerProvider provider =
        SdkTracerProvider.builder()
            .addSpanProcessor(SimpleSpanProcessor.create(new RedactingSpanExporter(collected)))
            .build();
    try {
      Tracer tracer = provider.get("redaction-test");
      Span span = tracer.spanBuilder("operation").startSpan();
      span.addEvent("auth-check", Attributes.of(PASSWORD, "hunter2", NOTE, "token=" + BEARER));
      // recordException lands an "exception" event whose exception.message/stacktrace carry the
      // thrown text; a secret in a thrown message must not reach the collector in the clear.
      span.recordException(new IllegalStateException("upstream rejected " + BEARER));
      span.end();

      List<SpanData> spans = collected.getFinishedSpanItems();
      assertEquals(1, spans.size(), "exactly one span should be exported");
      List<EventData> events = spans.get(0).getEvents();

      EventData authEvent =
          events.stream()
              .filter(e -> e.getName().equals("auth-check"))
              .findFirst()
              .orElseThrow(() -> new AssertionError("auth-check event missing"));
      // Secret-family event-attribute key redacted wholesale.
      assertEquals(Redactor.REDACTED, authEvent.getAttributes().get(PASSWORD));
      // Pattern secret inside a non-secret-keyed event attribute scrubbed in place.
      assertEquals("token=" + Redactor.REDACTED, authEvent.getAttributes().get(NOTE));
      // Event name and timestamp are preserved; only attributes are rewritten.
      assertFalse(authEvent.getName().isBlank(), "event name must survive redaction");

      // No cleartext bearer token survives in ANY exported event attribute (manual or exception).
      String allEventText =
          events.stream()
              .flatMap(e -> e.getAttributes().asMap().values().stream())
              .map(String::valueOf)
              .reduce("", (a, b) -> a + "\n" + b);
      assertFalse(allEventText.contains(BEARER), "BEARER leaked via an exported event attribute");
      assertTrue(allEventText.contains(Redactor.REDACTED), "redaction marker absent from events");
    } finally {
      provider.close();
    }
  }

  @Test
  void redactsSecretPatternInSpanNameOnExport() {
    // The span name is operator-chosen text that can interpolate a secret (e.g. a URL or query
    // containing a bearer token). The TS vertical scrubs the name; this proves the Java decorator
    // scrubs it with the same value-scrubber while leaving a benign name untouched.
    InMemorySpanExporter collected = InMemorySpanExporter.create();
    SdkTracerProvider provider =
        SdkTracerProvider.builder()
            .addSpanProcessor(SimpleSpanProcessor.create(new RedactingSpanExporter(collected)))
            .build();
    try {
      Tracer tracer = provider.get("redaction-test");
      tracer.spanBuilder("fetch token=" + BEARER).startSpan().end();
      tracer.spanBuilder("GET /orders").startSpan().end();

      List<SpanData> spans = collected.getFinishedSpanItems();
      assertEquals(2, spans.size(), "both spans should be exported");

      String secretName =
          spans.stream()
              .map(SpanData::getName)
              .filter(n -> n.startsWith("fetch "))
              .findFirst()
              .orElseThrow(() -> new AssertionError("secret-bearing span name missing"));
      // The bearer pattern inside the name is scrubbed in place; no cleartext survives.
      assertEquals("fetch token=" + Redactor.REDACTED, secretName);
      assertFalse(secretName.contains(BEARER), "BEARER leaked in exported span name");

      // A name with no secret pattern is exported byte-for-byte unchanged.
      assertTrue(
          spans.stream().anyMatch(s -> s.getName().equals("GET /orders")),
          "benign span name must survive redaction unchanged");
    } finally {
      provider.close();
    }
  }

  @Test
  void preservesLuhnIdInSpanNameButScrubsCredentialOnExport() {
    // A span name is a low-cardinality operation identifier. A Luhn-valid 13-19 digit route segment
    // is a resource id, not a leaked card, so the name-specific scrubber must NOT redact it (the
    // value-scrubber used before this fix did, corrupting the name). Credential patterns in a name
    // (here an AWS access key id) must STILL be scrubbed.
    String nameWithLuhnId = "GET /v1/accounts/4532015112830366/balance";
    String nameWithAwsKey = "sync AKIAIOSFODNN7EXAMPLE";

    InMemorySpanExporter collected = InMemorySpanExporter.create();
    SdkTracerProvider provider =
        SdkTracerProvider.builder()
            .addSpanProcessor(SimpleSpanProcessor.create(new RedactingSpanExporter(collected)))
            .build();
    try {
      Tracer tracer = provider.get("redaction-test");
      tracer.spanBuilder(nameWithLuhnId).startSpan().end();
      tracer.spanBuilder(nameWithAwsKey).startSpan().end();

      List<SpanData> spans = collected.getFinishedSpanItems();
      assertEquals(2, spans.size(), "both spans should be exported");

      // The Luhn-valid account id survives byte-for-byte; the name is not corrupted by PAN
      // redaction.
      assertTrue(
          spans.stream().anyMatch(s -> s.getName().equals(nameWithLuhnId)),
          "span name with a Luhn-valid id must survive redaction unchanged");

      // The AWS key inside the other name is still scrubbed by the name-specific scrubber.
      String awsName =
          spans.stream()
              .map(SpanData::getName)
              .filter(n -> n.startsWith("sync "))
              .findFirst()
              .orElseThrow(() -> new AssertionError("aws-key span name missing"));
      assertEquals("sync " + Redactor.REDACTED, awsName);
    } finally {
      provider.close();
    }
  }

  @Test
  void redactsLinkAttributesOnExport() {
    // A secret carried on a span link (secret-family key and a pattern secret in a string value)
    // must be scrubbed the same as a span attribute. getLinks/redactLinks implement this; this is
    // its proof, with a benign link attribute as the negative control that survives.
    InMemorySpanExporter collected = InMemorySpanExporter.create();
    SdkTracerProvider provider =
        SdkTracerProvider.builder()
            .addSpanProcessor(SimpleSpanProcessor.create(new RedactingSpanExporter(collected)))
            .build();
    try {
      Tracer tracer = provider.get("redaction-test");
      // Start and end a span purely to obtain a valid, sampled span context to link to.
      Span upstream = tracer.spanBuilder("upstream").startSpan();
      SpanContext linkedContext = upstream.getSpanContext();
      upstream.end();

      tracer
          .spanBuilder("operation")
          .addLink(
              linkedContext,
              Attributes.of(PASSWORD, "hunter2", NOTE, "token=" + BEARER, USER, "alice"))
          .startSpan()
          .end();

      List<SpanData> spans = collected.getFinishedSpanItems();
      SpanData operation =
          spans.stream()
              .filter(s -> s.getName().equals("operation"))
              .findFirst()
              .orElseThrow(() -> new AssertionError("operation span missing"));

      List<LinkData> links = operation.getLinks();
      assertEquals(1, links.size(), "the operation span should carry exactly one link");
      Attributes linkAttrs = links.get(0).getAttributes();

      // Secret-family link-attribute key redacted wholesale.
      assertEquals(Redactor.REDACTED, linkAttrs.get(PASSWORD));
      // Pattern secret inside a non-secret-keyed link attribute scrubbed in place.
      assertEquals("token=" + Redactor.REDACTED, linkAttrs.get(NOTE));
      // Benign link attribute survives untouched (negative control).
      assertEquals("alice", linkAttrs.get(USER));
      // The linked span context itself is preserved; only attributes are rewritten.
      assertEquals(linkedContext, links.get(0).getSpanContext());

      // No cleartext bearer token survives in ANY exported link attribute value, and the marker is
      // present.
      String allLinkText =
          links.stream()
              .flatMap(l -> l.getAttributes().asMap().values().stream())
              .map(String::valueOf)
              .reduce("", (a, b) -> a + "\n" + b);
      assertFalse(allLinkText.contains(BEARER), "BEARER leaked via an exported link attribute");
      assertTrue(allLinkText.contains(Redactor.REDACTED), "redaction marker absent from links");
    } finally {
      provider.close();
    }
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
