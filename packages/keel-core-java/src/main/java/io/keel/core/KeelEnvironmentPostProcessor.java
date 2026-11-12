package io.keel.core;

import java.util.HashMap;
import java.util.Map;
import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Bridges the cross-vertical {@code KEEL_*} environment contract onto Spring's own property names,
 * so the Java service honors the same env vars as the Python/Rust/Go/TS services, and turns on
 * structured JSON logging with trace correlation. Explicit bridges are added at high priority;
 * static defaults at the lowest priority so application.yml and real env vars still win. OTLP
 * export is wired only when an endpoint is configured (tracing itself stays on, so log-to-trace
 * correlation works regardless).
 */
public class KeelEnvironmentPostProcessor implements EnvironmentPostProcessor {

  @Override
  public void postProcessEnvironment(
      ConfigurableEnvironment environment, SpringApplication application) {
    Map<String, Object> bridges = new HashMap<>();
    bridge(environment, bridges, "KEEL_PORT", "server.port");
    bridge(environment, bridges, "KEEL_LOG_LEVEL", "logging.level.root");
    bridge(environment, bridges, "KEEL_SERVICE_NAME", "spring.application.name");
    bridge(environment, bridges, "KEEL_MAX_BODY_BYTES", "server.tomcat.max-swallow-size");
    // Bound form bodies at the connector too (Tomcat parses form-urlencoded before the filter
    // stream wrapper sees it); the JSON API surface is bounded by the body-limit filter.
    bridge(environment, bridges, "KEEL_MAX_BODY_BYTES", "server.tomcat.max-http-form-post-size");
    bridge(
        environment,
        bridges,
        "KEEL_VERSION",
        "management.opentelemetry.resource-attributes.service.version");
    bridge(
        environment,
        bridges,
        "KEEL_ENVIRONMENT",
        "management.opentelemetry.resource-attributes.deployment.environment.name");

    String otlpEndpoint = environment.getProperty("KEEL_OTLP_ENDPOINT");
    if (otlpEndpoint != null && !otlpEndpoint.isEmpty()) {
      // Boot 4 relocated this from the Boot 3 name management.otlp.tracing.endpoint; the old
      // name is deprecated-at-error and no longer bound, so a span exporter is only wired under
      // the new namespace.
      bridges.put("management.opentelemetry.tracing.export.otlp.endpoint", otlpEndpoint);
      // The metrics exporter is gated the same way as the span exporter: off unless an endpoint
      // is configured (see the default below), so a service without a collector does not emit a
      // failing push every step. The Micrometer OTLP registry wants the full metrics-signal URL
      // (unlike the tracing exporter it does not append the /v1/metrics path itself).
      bridges.put("management.otlp.metrics.export.enabled", "true");
      bridges.put("management.otlp.metrics.export.url", otlpMetricsUrl(otlpEndpoint));
    }
    environment.getPropertySources().addFirst(new MapPropertySource("keel-bridges", bridges));

    Map<String, Object> defaults = new HashMap<>();
    defaults.put("logging.structured.format.console", "ecs");
    defaults.put("management.tracing.sampling.probability", "1.0");
    defaults.put("spring.threads.virtual.enabled", "true");
    // No collector configured -> record the HTTP timers in-memory for actuator but export nothing,
    // matching the trace exporter being wired only when KEEL_OTLP_ENDPOINT is set.
    defaults.put("management.otlp.metrics.export.enabled", "false");
    // Export the request-duration histogram in seconds (the OTel http.server.request.duration
    // unit); Micrometer's OTLP registry defaults to milliseconds otherwise. The name is the
    // post-rename OTel identity (HttpServerMetricsAutoConfiguration) so the bucket config matches.
    defaults.put("management.otlp.metrics.export.base-time-unit", "seconds");
    defaults.put(
        "management.metrics.distribution.percentiles-histogram.http.server.request.duration",
        "true");
    environment.getPropertySources().addLast(new MapPropertySource("keel-defaults", defaults));
  }

  /**
   * Derives the OTLP metrics-signal URL from the base endpoint. Accepts an endpoint already ending
   * in {@code /v1/metrics} (idempotent) or a bare collector base (to which the signal path is
   * appended), so KEEL_OTLP_ENDPOINT can be the same base value the trace exporter consumes.
   */
  private static String otlpMetricsUrl(String endpoint) {
    String trimmed =
        endpoint.endsWith("/") ? endpoint.substring(0, endpoint.length() - 1) : endpoint;
    return trimmed.endsWith("/v1/metrics") ? trimmed : trimmed + "/v1/metrics";
  }

  private static void bridge(
      ConfigurableEnvironment environment,
      Map<String, Object> target,
      String envKey,
      String property) {
    String value = environment.getProperty(envKey);
    if (value != null && !value.isEmpty()) {
      target.put(property, value);
    }
  }
}
