package io.keel.reference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.keel.core.conformance.Conformance;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
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

  @DynamicPropertySource
  static void databaseUrl(DynamicPropertyRegistry registry) {
    registry.add("keel.database-url", () -> System.getenv("KEEL_TEST_DATABASE_URL"));
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
