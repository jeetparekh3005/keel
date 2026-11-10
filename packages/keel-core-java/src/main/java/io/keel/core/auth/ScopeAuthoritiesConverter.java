package io.keel.core.auth;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Maps a verified JWT's scopes and roles to Spring Security authorities. Scopes become {@code
 * SCOPE_*} authorities (what {@code @PreAuthorize("hasAuthority('SCOPE_items:write')")} checks),
 * read from the {@code scope} claim (space-delimited string) and the {@code scp} claim, which is
 * accepted as either an array (most IdPs) or a space-delimited string (Microsoft Entra). Roles
 * become {@code ROLE_*} authorities.
 */
public final class ScopeAuthoritiesConverter
    implements Converter<Jwt, Collection<GrantedAuthority>> {

  @Override
  public Collection<GrantedAuthority> convert(Jwt jwt) {
    Set<String> authorities = new LinkedHashSet<>();
    addScopes(authorities, jwt.getClaim("scope"));
    addScopes(authorities, jwt.getClaim("scp"));
    addRoles(authorities, jwt.getClaim("roles"));
    Object realmAccess = jwt.getClaim("realm_access");
    if (realmAccess instanceof Map<?, ?> map) {
      addRoles(authorities, map.get("roles"));
    }
    return authorities.stream().map(a -> (GrantedAuthority) new SimpleGrantedAuthority(a)).toList();
  }

  private static void addScopes(Set<String> authorities, Object claim) {
    if (claim instanceof String s) {
      for (String scope : s.split("\\s+")) {
        if (!scope.isBlank()) {
          authorities.add("SCOPE_" + scope);
        }
      }
    } else if (claim instanceof Collection<?> collection) {
      for (Object scope : collection) {
        if (scope instanceof String s && !s.isBlank()) {
          authorities.add("SCOPE_" + s);
        }
      }
    }
  }

  private static void addRoles(Set<String> authorities, Object claim) {
    if (claim instanceof Collection<?> collection) {
      for (Object role : collection) {
        if (role instanceof String s && !s.isBlank()) {
          authorities.add("ROLE_" + s);
        }
      }
    }
  }
}
