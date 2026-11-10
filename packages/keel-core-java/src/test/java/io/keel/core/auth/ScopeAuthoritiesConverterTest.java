package io.keel.core.auth;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;

class ScopeAuthoritiesConverterTest {

  private final ScopeAuthoritiesConverter converter = new ScopeAuthoritiesConverter();

  private static Jwt jwt(Map<String, Object> claims) {
    Jwt.Builder builder = Jwt.withTokenValue("token").header("alg", "none");
    claims.forEach(builder::claim);
    return builder.build();
  }

  private Set<String> authorities(Map<String, Object> claims) {
    Collection<GrantedAuthority> granted = converter.convert(jwt(claims));
    return granted.stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
  }

  @Test
  void mapsSpaceDelimitedScopeClaim() {
    assertTrue(
        authorities(Map.of("scope", "items:read items:write"))
            .containsAll(Set.of("SCOPE_items:read", "SCOPE_items:write")));
  }

  @Test
  void mapsScpAsArray() {
    assertTrue(authorities(Map.of("scp", List.of("items:read"))).contains("SCOPE_items:read"));
  }

  @Test
  void mapsScpAsSpaceDelimitedString() {
    assertTrue(authorities(Map.of("scp", "items:read items:write")).contains("SCOPE_items:write"));
  }

  @Test
  void mapsRealmRolesToRoleAuthorities() {
    assertTrue(
        authorities(Map.of("realm_access", Map.of("roles", List.of("admin"))))
            .contains("ROLE_admin"));
  }
}
