package io.keel.core.telemetry;

import io.keel.core.logging.Redactor;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.trace.data.DelegatingSpanData;
import io.opentelemetry.sdk.trace.data.EventData;
import io.opentelemetry.sdk.trace.data.LinkData;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * A {@link SpanExporter} decorator that applies the same secret redaction as the JSON log sink
 * ({@link io.keel.core.logging.RedactingJsonCustomizer} / {@link Redactor}) to exported span
 * attributes, so the OTLP span-export path cannot leak secrets that the log path already scrubs
 * (parity epic #419, v0.6). A secret-family attribute key is redacted wholesale to {@code
 * [REDACTED]} and every string (or string-array) attribute value is scrubbed for secret patterns
 * (JWT/AWS/bearer/PEM/Luhn) before the span is handed to the delegate exporter.
 *
 * <p>Redaction happens on export rather than at span creation so it is unconditional:
 * instrumentation anywhere in the service, including library-emitted spans, is covered without each
 * call site having to remember to scrub. Each {@link SpanData} is wrapped in a {@link
 * DelegatingSpanData} that rewrites the attributes on the span itself and, with the same {@link
 * Redactor} families, the attributes carried on every span event (including the {@code exception.*}
 * attributes of a recorded exception) and every link; trace/span ids, timing, status, event names
 * and timestamps, link span contexts, and resource are left untouched so the exported span is
 * otherwise identical. The pattern families themselves live solely in {@link Redactor}; this class
 * never duplicates them.
 */
public final class RedactingSpanExporter implements SpanExporter {

  private final SpanExporter delegate;

  public RedactingSpanExporter(SpanExporter delegate) {
    this.delegate = delegate;
  }

  @Override
  public CompletableResultCode export(Collection<SpanData> spans) {
    List<SpanData> redacted = new ArrayList<>(spans.size());
    for (SpanData span : spans) {
      redacted.add(redact(span));
    }
    return delegate.export(redacted);
  }

  @Override
  public CompletableResultCode flush() {
    return delegate.flush();
  }

  @Override
  public CompletableResultCode shutdown() {
    return delegate.shutdown();
  }

  private static SpanData redact(SpanData span) {
    Attributes redactedAttributes = redactAttributes(span.getAttributes());
    List<EventData> redactedEvents = redactEvents(span.getEvents());
    List<LinkData> redactedLinks = redactLinks(span.getLinks());
    return new DelegatingSpanData(span) {
      @Override
      public Attributes getAttributes() {
        return redactedAttributes;
      }

      @Override
      public int getTotalAttributeCount() {
        // Redaction never adds or drops attributes, only rewrites values, so the original count
        // (which also accounts for any dropped-by-limit attributes) stays correct.
        return span.getTotalAttributeCount();
      }

      @Override
      public List<EventData> getEvents() {
        return redactedEvents;
      }

      @Override
      public List<LinkData> getLinks() {
        return redactedLinks;
      }
    };
  }

  // Rebuild each event with its attributes scrubbed, preserving the event name, timestamp, and the
  // dropped-by-limit count. An exception recorded via Span.recordException lands here as an event
  // carrying exception.message/exception.stacktrace, so a secret in a thrown message is scrubbed.
  private static List<EventData> redactEvents(List<EventData> events) {
    List<EventData> out = new ArrayList<>(events.size());
    for (EventData event : events) {
      out.add(
          EventData.create(
              event.getEpochNanos(),
              event.getName(),
              redactAttributes(event.getAttributes()),
              event.getTotalAttributeCount()));
    }
    return out;
  }

  // Rebuild each link with its attributes scrubbed, preserving the linked span context and the
  // dropped-by-limit count.
  private static List<LinkData> redactLinks(List<LinkData> links) {
    List<LinkData> out = new ArrayList<>(links.size());
    for (LinkData link : links) {
      out.add(
          LinkData.create(
              link.getSpanContext(),
              redactAttributes(link.getAttributes()),
              link.getTotalAttributeCount()));
    }
    return out;
  }

  @SuppressWarnings({"unchecked", "rawtypes"})
  private static Attributes redactAttributes(Attributes attributes) {
    AttributesBuilder builder = Attributes.builder();
    attributes.forEach((key, value) -> {
      if (Redactor.isSecretKey(key.getKey())) {
        builder.put(AttributeKey.stringKey(key.getKey()), Redactor.REDACTED);
        return;
      }
      switch (key.getType()) {
        case STRING ->
            builder.put(AttributeKey.stringKey(key.getKey()), Redactor.scrubText((String) value));
        case STRING_ARRAY -> {
          List<String> scrubbed = new ArrayList<>();
          for (String element : (List<String>) value) {
            scrubbed.add(element == null ? null : Redactor.scrubText(element));
          }
          builder.put(AttributeKey.stringArrayKey(key.getKey()), scrubbed);
        }
        // Non-string types (boolean/long/double and their arrays) cannot carry a textual
        // secret pattern, so they pass through with their original typed key unchanged.
        default -> builder.put((AttributeKey) key, value);
      }
    });
    return builder.build();
  }
}
