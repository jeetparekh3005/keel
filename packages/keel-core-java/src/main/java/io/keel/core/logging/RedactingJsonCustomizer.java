package io.keel.core.logging;

import org.springframework.boot.json.JsonWriter;
import org.springframework.boot.logging.structured.StructuredLoggingJsonMembersCustomizer;

/**
 * Redacts the structured JSON log output: a secret-family key is redacted wholesale and every
 * string value is scrubbed for secret patterns (JWT/AWS/bearer/PEM/Luhn). Applied to every log
 * event via Spring Boot's structured-logging value processor, so redaction covers the message and
 * all members, matching the other verticals. Registered via META-INF/spring.factories so it is
 * active during early logging initialization.
 */
public class RedactingJsonCustomizer<T> implements StructuredLoggingJsonMembersCustomizer<T> {

  @Override
  public void customize(JsonWriter.Members<T> members) {
    JsonWriter.ValueProcessor<Object> processor =
        (path, value) -> {
          String name = (path != null) ? path.name() : null;
          if (name != null && Redactor.isSecretKey(name)) {
            return Redactor.REDACTED;
          }
          if (value instanceof String string) {
            return Redactor.scrubText(string);
          }
          return value;
        };
    members.applyingValueProcessor(processor);
  }
}
