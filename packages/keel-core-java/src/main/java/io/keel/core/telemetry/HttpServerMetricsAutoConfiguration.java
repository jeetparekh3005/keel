package io.keel.core.telemetry;

import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.config.MeterFilter;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.context.annotation.Bean;

/**
 * Renames Boot's built-in HTTP server meters to the OpenTelemetry semantic-convention names so the
 * OTLP export carries the cross-vertical metric identities (parity epic #419): the {@code
 * http.server.requests} timer becomes {@code http.server.request.duration} and its companion active
 * long-task timer ({@code http.server.requests.active}, created by Micrometer's observation
 * handler) becomes {@code http.server.active_requests}.
 *
 * <p>Only the meter name is remapped; the route-template {@code uri}, {@code method}, and {@code
 * status} tags Boot already attaches are preserved, so cardinality stays bounded by the URI pattern
 * rather than the concrete path. A {@link MeterFilter} is applied to every registry in the context
 * (the OTLP registry and any test registry alike), so what is asserted in a test is exactly what is
 * exported.
 */
@AutoConfiguration
@ConditionalOnClass(MeterRegistry.class)
public class HttpServerMetricsAutoConfiguration {

  static final String BOOT_REQUESTS = "http.server.requests";
  static final String BOOT_ACTIVE_REQUESTS = "http.server.requests.active";
  static final String OTEL_REQUEST_DURATION = "http.server.request.duration";
  static final String OTEL_ACTIVE_REQUESTS = "http.server.active_requests";

  @Bean
  public MeterFilter httpServerMetricsOtelNaming() {
    return new MeterFilter() {
      @Override
      public Meter.Id map(Meter.Id id) {
        return switch (id.getName()) {
          case BOOT_REQUESTS -> id.withName(OTEL_REQUEST_DURATION);
          case BOOT_ACTIVE_REQUESTS -> id.withName(OTEL_ACTIVE_REQUESTS);
          default -> id;
        };
      }
    };
  }
}
