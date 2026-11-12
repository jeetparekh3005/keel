package io.keel.core.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.micrometer.core.instrument.LongTaskTimer;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.registry.otlp.OtlpMeterRegistry;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * Proves the HTTP server request metrics are instrumented, named to the OpenTelemetry semantic
 * convention, route-templated, and bound to the OTLP export registry. Deliberately self-contained
 * (no Postgres, no IdP): a minimal web context with a single templated route, a permit-all security
 * chain (keel-core's deny-by-default chain is excluded so the probe is reachable), and the OTLP
 * metrics exporter forced on. The assertions fail if the OTLP registry dependency or the
 * OTel-naming auto-config is removed.
 */
@SpringBootTest(
    classes = {
      HttpServerMetricsTest.App.class,
      HttpServerMetricsTest.Probe.class,
      HttpServerMetricsTest.PermitAllSecurity.class
    },
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
      // Force the OTLP meter registry on (it is gated off by default without a collector endpoint)
      // so its presence can be asserted; the URL is never actually dialed in the test.
      "management.otlp.metrics.export.enabled=true",
      "management.otlp.metrics.export.url=http://localhost:4318/v1/metrics",
      "management.otlp.metrics.export.step=1s"
    })
class HttpServerMetricsTest {

  @LocalServerPort int port;

  @org.springframework.beans.factory.annotation.Autowired MeterRegistry meterRegistry;

  @org.springframework.beans.factory.annotation.Autowired ApplicationContext applicationContext;

  @Test
  void recordsOtelNamedRouteTemplatedDurationHistogram() {
    // Two distinct concrete paths must collapse onto one series keyed by the URI template, proving
    // the path parameter is templated (bounded cardinality), not emitted raw.
    assertEquals(200, get("/metrics-probe/42"));
    assertEquals(200, get("/metrics-probe/99"));

    Timer duration =
        meterRegistry
            .find(HttpServerMetricsAutoConfiguration.OTEL_REQUEST_DURATION)
            .tag("uri", "/metrics-probe/{id}")
            .tag("method", "GET")
            .tag("status", "200")
            .timer();
    assertNotNull(
        duration,
        "no http.server.request.duration timer tagged with the URI template - instrumentation,"
            + " templating, or the OTel-naming filter is missing");
    assertTrue(
        duration.count() >= 2,
        "expected both requests collapsed onto the templated series, got count="
            + duration.count());

    // No raw-path series leaked (would be unbounded cardinality).
    assertNotNull(
        meterRegistry.find(HttpServerMetricsAutoConfiguration.OTEL_REQUEST_DURATION).timer());
    org.junit.jupiter.api.Assertions.assertNull(
        meterRegistry
            .find(HttpServerMetricsAutoConfiguration.OTEL_REQUEST_DURATION)
            .tag("uri", "/metrics-probe/42")
            .timer(),
        "a raw concrete path was recorded - path parameter was not templated");

    // The active-requests gauge/up-down-counter is the renamed long-task timer; it exists once the
    // first server observation has run.
    LongTaskTimer active =
        meterRegistry.find(HttpServerMetricsAutoConfiguration.OTEL_ACTIVE_REQUESTS).longTaskTimer();
    assertNotNull(active, "no http.server.active_requests long-task timer");

    // The OTLP export registry is on the classpath and bound; removing the dependency fails here.
    assertTrue(
        applicationContext.getBeanNamesForType(OtlpMeterRegistry.class).length > 0,
        "no OtlpMeterRegistry bean - metrics are recorded but not exported over OTLP");
  }

  private int get(String path) {
    try {
      HttpResponse<String> res =
          HttpClient.newHttpClient()
              .send(
                  HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                      .GET()
                      .build(),
                  BodyHandlers.ofString());
      return res.statusCode();
    } catch (Exception e) {
      throw new AssertionError("request failed: " + e.getMessage(), e);
    }
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration(
      exclude = {
        // No DataSource in this slice (keel-core carries the jdbc starter) and keel-core's
        // deny-by-default chain would 401 the probe before it reaches the handler-mapped template.
        DataSourceAutoConfiguration.class,
        io.keel.core.KeelCoreAutoConfiguration.class
      })
  static class App {}

  @RestController
  static class Probe {
    @GetMapping("/metrics-probe/{id}")
    String probe(@PathVariable String id) {
      return "ok-" + id;
    }
  }

  @EnableWebSecurity
  static class PermitAllSecurity {
    @Bean
    SecurityFilterChain permitAll(HttpSecurity http) throws Exception {
      return http.csrf(csrf -> csrf.disable())
          .authorizeHttpRequests(authorize -> authorize.anyRequest().permitAll())
          .build();
    }
  }
}
