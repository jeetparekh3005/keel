package io.keel.core.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.keel.core.config.KeelProperties.ApiKeyEntry;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken;

/**
 * Unit coverage for the hashing, scope mapping, and miss behavior of {@link ApiKeyAuthenticator}.
 */
class ApiKeyAuthenticatorTest {

  @Test
  void hashMatchesTheCanonicalSha256HexUsedByTheOtherVerticals() {
    // hashlib.sha256(b"test").hexdigest() - byte-for-byte parity with the Python authenticator.
    assertEquals(
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        ApiKeyAuthenticator.hashApiKey("test"));
  }

  @Test
  void verifiesAKeyAndMapsScopesAndRolesToAuthorities() {
    ApiKeyAuthenticator authenticator =
        ApiKeyAuthenticator.fromProperties(
            List.of(
                new ApiKeyEntry(
                    ApiKeyAuthenticator.hashApiKey("partner-secret"),
                    "partner",
                    List.of("items:read", "items:write"),
                    List.of("machine"))));

    PreAuthenticatedAuthenticationToken auth = authenticator.authenticate("partner-secret");

    assertTrue(auth.isAuthenticated());
    assertEquals("partner", auth.getPrincipal());
    assertTrue(auth.getAuthorities().contains(new SimpleGrantedAuthority("SCOPE_items:read")));
    assertTrue(auth.getAuthorities().contains(new SimpleGrantedAuthority("SCOPE_items:write")));
    assertTrue(auth.getAuthorities().contains(new SimpleGrantedAuthority("ROLE_machine")));
  }

  @Test
  void rejectsAnUnknownKey() {
    ApiKeyAuthenticator authenticator =
        ApiKeyAuthenticator.fromProperties(
            List.of(
                new ApiKeyEntry(
                    ApiKeyAuthenticator.hashApiKey("right"), "s", List.of(), List.of())));
    assertThrows(BadCredentialsException.class, () -> authenticator.authenticate("wrong"));
  }

  @Test
  void rejectsEveryKeyWhenNoneAreConfigured() {
    ApiKeyAuthenticator authenticator = ApiKeyAuthenticator.fromProperties(List.of());
    assertThrows(BadCredentialsException.class, () -> authenticator.authenticate("anything"));
  }
}
