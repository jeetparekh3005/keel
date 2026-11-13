package io.keel.core.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

/**
 * Verifies the resource-server JWT path against a real Keycloak (epic #419, v0.6 parity, audit
 * #34).
 *
 * <p>Runs only when {@code KEEL_KEYCLOAK_URL} is set; CI imports {@code deploy/keycloak/realm.json}
 * into a Keycloak container (see {@code .github/workflows/java.yml}) and skipped otherwise. Unlike
 * the reference-service conformance test, which replaces the decoder with an {@code alg=none} stub,
 * this test builds a production {@link NimbusJwtDecoder#withJwkSetUri} against the live JWKS
 * endpoint: it mints a real service-account token via {@code client_credentials}, fetches and
 * caches the signing keys over HTTP, and cryptographically verifies the RS256 signature plus the
 * iss/aud/exp validators that {@link SecurityConfig} wires in production. This is the live
 * counterpart proving the real verification stack works end to end against Keycloak.
 */
class KeycloakJwksIntegrationTest {

  private static final String KC_URL = System.getenv("KEEL_KEYCLOAK_URL");
  private static final String REALM = envOrDefault("KEEL_KEYCLOAK_REALM", "keel");
  private static final String CLIENT_ID = envOrDefault("KEEL_KEYCLOAK_CLIENT_ID", "keel-api");
  private static final String CLIENT_SECRET =
      envOrDefault("KEEL_KEYCLOAK_CLIENT_SECRET", "test-secret");
  private static final String AUDIENCE = envOrDefault("KEEL_OIDC_AUDIENCE", "keel-api");

  private static String envOrDefault(String name, String fallback) {
    String value = System.getenv(name);
    return (value == null || value.isEmpty()) ? fallback : value;
  }

  private static String realmBase() {
    return KC_URL + "/realms/" + REALM;
  }

  @Test
  @EnabledIfEnvironmentVariable(named = "KEEL_KEYCLOAK_URL", matches = ".+")
  void decodesAndVerifiesALiveKeycloakTokenAgainstLiveJwks() throws Exception {
    String token = mintClientCredentialsToken();

    // The production decoder: fetch the key set over HTTP from the live JWKS endpoint and verify
    // the RS256 signature, exactly as SecurityConfig#jwtDecoder does (not the alg=none stub).
    String issuer = realmBase();
    NimbusJwtDecoder decoder =
        NimbusJwtDecoder.withJwkSetUri(issuer + "/protocol/openid-connect/certs").build();
    List<OAuth2TokenValidator<Jwt>> validators =
        List.of(
            new JwtTimestampValidator(),
            new JwtIssuerValidator(issuer),
            audienceValidator(AUDIENCE));
    decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(validators));

    Jwt jwt = decoder.decode(token);

    assertNotNull(jwt.getSubject(), "verified token carried no subject (service-account user id)");
    assertFalse(jwt.getSubject().isEmpty(), "verified token carried an empty subject");
    assertEquals(issuer, jwt.getIssuer().toString(), "issuer claim did not match the realm");
    assertTrue(
        jwt.getAudience().contains(AUDIENCE),
        "verified token was not bound to the expected audience: " + jwt.getAudience());
    assertEquals("RS256", jwt.getHeaders().get("alg"), "live token was not signed with RS256");

    // The scope-to-authority mapping the resource server applies in production: a service-account
    // token always carries at least one granted scope/role.
    ScopeAuthoritiesConverter converter = new ScopeAuthoritiesConverter();
    java.util.Set<String> authorities =
        converter.convert(jwt).stream()
            .map(GrantedAuthority::getAuthority)
            .collect(Collectors.toSet());
    assertFalse(
        authorities.isEmpty(),
        "live service-account token mapped to no authorities: " + jwt.getClaims());
  }

  private static String mintClientCredentialsToken() throws Exception {
    String form =
        "grant_type=client_credentials"
            + "&client_id="
            + URLEncoder.encode(CLIENT_ID, StandardCharsets.UTF_8)
            + "&client_secret="
            + URLEncoder.encode(CLIENT_SECRET, StandardCharsets.UTF_8);
    HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    HttpRequest request =
        HttpRequest.newBuilder(URI.create(realmBase() + "/protocol/openid-connect/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .timeout(Duration.ofSeconds(15))
            .POST(BodyPublishers.ofString(form))
            .build();
    HttpResponse<String> response = client.send(request, BodyHandlers.ofString());
    assertEquals(
        200,
        response.statusCode(),
        "token endpoint did not return 200: " + response.statusCode() + " " + response.body());
    return extractAccessToken(response.body());
  }

  private static String extractAccessToken(String body) {
    Matcher matcher = Pattern.compile("\"access_token\"\\s*:\\s*\"([^\"]+)\"").matcher(body);
    assertTrue(matcher.find(), "token response had no access_token");
    return matcher.group(1);
  }

  private static OAuth2TokenValidator<Jwt> audienceValidator(String audience) {
    return jwt -> {
      if (jwt.getAudience() != null && jwt.getAudience().contains(audience)) {
        return org.springframework.security.oauth2.core.OAuth2TokenValidatorResult.success();
      }
      return org.springframework.security.oauth2.core.OAuth2TokenValidatorResult.failure(
          new org.springframework.security.oauth2.core.OAuth2Error(
              "invalid_token", "required audience is missing", null));
    };
  }
}
