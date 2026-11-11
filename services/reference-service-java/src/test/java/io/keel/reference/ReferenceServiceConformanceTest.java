package io.keel.reference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import io.keel.core.conformance.Conformance;
import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * Runs the platform conformance suite plus items CRUD against the fully composed service on a real
 * Postgres (gated on KEEL_TEST_DATABASE_URL, supplied in CI). Auth is stubbed by replacing the JWT
 * decoder, so "reader"/"writer" bearer tokens map to principals with the expected scopes without a
 * real IdP.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(ReferenceServiceConformanceTest.StubAuthConfig.class)
@EnabledIfEnvironmentVariable(named = "KEEL_TEST_DATABASE_URL", matches = ".+")
class ReferenceServiceConformanceTest {

  @LocalServerPort int port;

  @Autowired Tracer tracer;

  @DynamicPropertySource
  static void properties(DynamicPropertyRegistry registry) {
    registry.add("keel.database-url", () -> System.getenv("KEEL_TEST_DATABASE_URL"));
    // A small body limit so over-limit requests exercise the 413 paths.
    registry.add("keel.max-body-bytes", () -> "64");
  }

  @Test
  void passesConformanceAndRoundTripsItems() {
    Conformance conformance = new Conformance("http://localhost:" + port);

    conformance.assertHealth();
    conformance.assertSecurityHeaders();
    conformance.assertCorsDenyByDefault();
    conformance.assertDeniesAnonymous("POST", "/v1/items");
    conformance.assertRequiresScope("POST", "/v1/items", "reader", "{\"name\":\"widget\"}");

    HttpResponse<String> created =
        conformance.authorized("POST", "/v1/items", "writer", "{\"name\":\"widget\"}");
    assertEquals(201, created.statusCode());
    String id = extractId(created.body());

    HttpResponse<String> fetched = conformance.authorized("GET", "/v1/items/" + id, "reader", null);
    assertEquals(200, fetched.statusCode());
    assertTrue(fetched.body().contains("widget"));

    conformance.assertProblemResponse(
        conformance.authorized("GET", "/v1/items/does-not-exist", "reader", null), 404);
    conformance.assertProblemResponse(
        conformance.authorized("POST", "/v1/items", "writer", "{\"name\":\"\"}"), 400);

    // Hard paths: an over-limit body (Content-Length) is a 413 that still carries the headers.
    conformance.assertSecurityHeadersOn413(
        "POST", "/v1/items", "{\"name\":\"" + "x".repeat(200) + "\"}");
  }

  @Test
  void boundsAChunkedBodyThatExceedsTheLimit() {
    // The exact review finding: a chunked request (no Content-Length) must not bypass the body
    // limit. An authenticated writer sends a chunked over-limit body; expect a 413, not success.
    byte[] body = ("{\"name\":\"" + "x".repeat(500) + "\"}").getBytes(StandardCharsets.UTF_8);
    HttpResponse<String> res =
        send(
            HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/v1/items"))
                .header("Authorization", "Bearer writer")
                .header("Content-Type", "application/json")
                // ofInputStream has unknown length, so HttpClient sends Transfer-Encoding: chunked.
                .POST(BodyPublishers.ofInputStream(() -> new ByteArrayInputStream(body)))
                .build());
    assertEquals(413, res.statusCode(), "chunked over-limit body must be rejected with 413");
  }

  @Test
  void logLineCarriesTheTraceId() {
    // Proves trace correlation produces output (the actuator tracing auto-config wires a Tracer
    // and the MDC bridge): a log emitted inside a span carries traceId in the MDC.
    Logger logbackLogger = (Logger) LoggerFactory.getLogger("io.keel.trace-correlation-test");
    ListAppender<ILoggingEvent> appender = new ListAppender<>();
    appender.start();
    logbackLogger.addAppender(appender);
    Span span = tracer.nextSpan().name("unit-of-work").start();
    try (Tracer.SpanInScope scope = tracer.withSpan(span)) {
      logbackLogger.info("inside span");
    } finally {
      span.end();
    }
    assertTrue(appender.list.size() >= 1, "no log event captured");
    assertNotNull(
        appender.list.get(0).getMDCPropertyMap().get("traceId"),
        "log event carried no traceId in the MDC");
  }

  private static HttpResponse<String> send(HttpRequest request) {
    try {
      return HttpClient.newHttpClient().send(request, BodyHandlers.ofString());
    } catch (Exception e) {
      throw new AssertionError("request failed: " + e.getMessage(), e);
    }
  }

  private static String extractId(String body) {
    Matcher matcher = Pattern.compile("\"id\"\\s*:\\s*\"([^\"]+)\"").matcher(body);
    assertTrue(matcher.find(), "response had no id: " + body);
    return matcher.group(1);
  }

  @TestConfiguration
  static class StubAuthConfig {
    @Bean
    JwtDecoder jwtDecoder() {
      return token ->
          switch (token) {
            case "reader" -> stubJwt("u-reader", "items:read");
            case "writer" -> stubJwt("u-writer", "items:read items:write");
            default -> throw new BadJwtException("invalid token");
          };
    }

    private static Jwt stubJwt(String subject, String scope) {
      Instant now = Instant.now();
      return Jwt.withTokenValue(subject)
          .header("alg", "none")
          .subject(subject)
          .claim("scope", scope)
          .issuedAt(now)
          .expiresAt(now.plusSeconds(300))
          .build();
    }
  }
}

/** A separate context whose readiness check fails, proving /readyz reports 503 (not 200). */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import({
  ReferenceServiceConformanceTest.StubAuthConfig.class,
  ReferenceServiceReadinessTest.NotReadyConfig.class
})
@EnabledIfEnvironmentVariable(named = "KEEL_TEST_DATABASE_URL", matches = ".+")
class ReferenceServiceReadinessTest {

  @LocalServerPort int port;

  @DynamicPropertySource
  static void databaseUrl(DynamicPropertyRegistry registry) {
    registry.add("keel.database-url", () -> System.getenv("KEEL_TEST_DATABASE_URL"));
  }

  @Test
  void readyzReports503WhenTheDependencyFails() {
    new Conformance("http://localhost:" + port).assertReadyzReportsNotReady();
  }

  @TestConfiguration
  static class NotReadyConfig {
    @Bean
    @org.springframework.context.annotation.Primary
    io.keel.core.web.ReadinessCheck failingReadiness() {
      return () -> false;
    }
  }
}
