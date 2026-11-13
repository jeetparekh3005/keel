package io.keel.core.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Proves the X-API-Key filter integrates with the deny-by-default resource-server chain: a valid
 * key reaches a scope-guarded route (200), an absent or wrong key is 401, a valid key lacking the
 * route's scope is 403, and the JWT path still authenticates. Self-contained (no Postgres, no IdP):
 * the real {@link SecurityConfig} chain from keel-core is wired via {@link
 * KeelCoreAutoConfiguration}, the JWT decoder is stubbed, and the API keys are configured as
 * SHA-256 hashes computed with the production hasher - so the assertions fail if the filter, the
 * hashing, or the scope mapping break.
 */
@SpringBootTest(
    classes = {
      ApiKeyAuthenticationTest.App.class,
      ApiKeyAuthenticationTest.Probe.class,
      ApiKeyAuthenticationTest.StubAuthConfig.class
    },
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ApiKeyAuthenticationTest {

  private static final String READER_KEY = "reader-plaintext-secret";
  private static final String WRITER_KEY = "writer-plaintext-secret";

  @LocalServerPort int port;

  @DynamicPropertySource
  static void apiKeys(DynamicPropertyRegistry registry) {
    // Keys are stored hashed: configure the SHA-256 digest of each plaintext, never the plaintext.
    registry.add("keel.api-keys[0].key-hash", () -> ApiKeyAuthenticator.hashApiKey(READER_KEY));
    registry.add("keel.api-keys[0].subject", () -> "u-api-reader");
    registry.add("keel.api-keys[0].scopes", () -> "items:read");
    registry.add("keel.api-keys[1].key-hash", () -> ApiKeyAuthenticator.hashApiKey(WRITER_KEY));
    registry.add("keel.api-keys[1].subject", () -> "u-api-writer");
    registry.add("keel.api-keys[1].scopes", () -> "items:read,items:write");
  }

  @Test
  void validApiKeyReachesScopeGuardedEndpoint() {
    HttpResponse<String> res = get("/probe/read", "X-API-Key", READER_KEY);
    assertEquals(200, res.statusCode(), "a valid X-API-Key with items:read must reach the route");
    assertTrue(res.body().contains("read-ok"), "handler did not run: " + res.body());
  }

  @Test
  void wrongApiKeyIsUnauthorized() {
    HttpResponse<String> res = get("/probe/read", "X-API-Key", "not-a-real-key");
    assertEquals(401, res.statusCode(), "an unknown X-API-Key must be 401");
    assertTrue(
        res.body().contains("urn:keel:error:unauthenticated"), "not problem+json: " + res.body());
  }

  @Test
  void absentCredentialIsUnauthorized() {
    HttpResponse<String> res = get("/probe/read");
    assertEquals(401, res.statusCode(), "no credential must be 401 (deny-by-default)");
  }

  @Test
  void apiKeyMissingScopeIsForbidden() {
    // The reader key authenticates (so this is not a 401) but lacks items:write, so @PreAuthorize
    // denies it: deny-by-default authentication passed, per-route scope authorization failed.
    HttpResponse<String> res = post("/probe/write", "X-API-Key", READER_KEY);
    assertEquals(403, res.statusCode(), "an authenticated api-key without the scope must be 403");
    assertTrue(
        res.body().contains("urn:keel:error:forbidden"), "not a forbidden problem: " + res.body());
  }

  @Test
  void apiKeyWithScopeReachesWriteEndpoint() {
    HttpResponse<String> res = post("/probe/write", "X-API-Key", WRITER_KEY);
    assertEquals(200, res.statusCode(), "the writer key carries items:write and must be allowed");
    assertTrue(res.body().contains("write-ok"), "handler did not run: " + res.body());
  }

  @Test
  void jwtPathStillAuthenticates() {
    // With no X-API-Key header the filter is transparent and the resource server verifies the
    // bearer token, proving the api-key filter did not displace the JWT path.
    HttpResponse<String> res = get("/probe/read", "Authorization", "Bearer reader");
    assertEquals(200, res.statusCode(), "the JWT bearer path must still reach the route");
    assertTrue(res.body().contains("read-ok"), "handler did not run: " + res.body());
  }

  private HttpResponse<String> get(String path, String... headers) {
    return send(request(path, headers).GET().build());
  }

  private HttpResponse<String> post(String path, String... headers) {
    return send(request(path, headers).POST(BodyPublishers.noBody()).build());
  }

  private HttpRequest.Builder request(String path, String... headers) {
    HttpRequest.Builder builder =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + path));
    for (int i = 0; i + 1 < headers.length; i += 2) {
      builder.header(headers[i], headers[i + 1]);
    }
    return builder;
  }

  private static HttpResponse<String> send(HttpRequest request) {
    try {
      return HttpClient.newHttpClient().send(request, BodyHandlers.ofString());
    } catch (Exception e) {
      throw new AssertionError("request failed: " + e.getMessage(), e);
    }
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
  static class App {}

  @RestController
  static class Probe {
    @GetMapping("/probe/read")
    @PreAuthorize("hasAuthority('SCOPE_items:read')")
    String read() {
      return "read-ok";
    }

    @PostMapping("/probe/write")
    @PreAuthorize("hasAuthority('SCOPE_items:write')")
    String write() {
      return "write-ok";
    }
  }

  @TestConfiguration
  static class StubAuthConfig {
    // Supplying a JwtDecoder bean suppresses the real JWKS-backed one (ConditionalOnMissingBean),
    // so the JWT branch can be exercised without an IdP. Not a real token (gitleaks): a bare word.
    @Bean
    JwtDecoder jwtDecoder() {
      return token ->
          switch (token) {
            case "reader" -> stubJwt("u-jwt-reader", "items:read");
            case "writer" -> stubJwt("u-jwt-writer", "items:read items:write");
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
