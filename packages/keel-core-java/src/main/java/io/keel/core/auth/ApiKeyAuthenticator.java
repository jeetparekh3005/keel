package io.keel.core.auth;

import io.keel.core.config.KeelProperties.ApiKeyEntry;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken;

/**
 * Verifies an opaque API key against a configured set of SHA-256 key hashes and maps it to an
 * authenticated principal (platform.yaml auth; ADR-0006). Mirrors the Python {@code
 * ApiKeyAuthenticator}: keys are stored <strong>hashed</strong> (never plaintext) so a memory or
 * config disclosure does not leak usable credentials; the presented key is hashed and looked up.
 *
 * <p>The resulting {@link org.springframework.security.core.Authentication} carries the entry's
 * scopes as {@code SCOPE_*} authorities and roles as {@code ROLE_*} authorities, so the same
 * {@code @PreAuthorize("hasAuthority('SCOPE_...')")} per-route checks that gate the JWT path apply
 * unchanged to an API-key caller.
 */
public final class ApiKeyAuthenticator {

  private final Map<String, Principal> byHash;

  /** A verified API-key caller: a subject and its granted Spring Security authorities. */
  private record Principal(String subject, List<GrantedAuthority> authorities) {}

  private ApiKeyAuthenticator(Map<String, Principal> byHash) {
    this.byHash = byHash;
  }

  /**
   * Build from the configured (already hashed) entries. Entries whose hash is blank are ignored; a
   * duplicate hash keeps the first entry. The configured {@code keyHash} is the SHA-256 hex digest
   * of the plaintext key (see {@link #hashApiKey(String)}).
   */
  public static ApiKeyAuthenticator fromProperties(Collection<ApiKeyEntry> entries) {
    Map<String, Principal> byHash = new LinkedHashMap<>();
    if (entries != null) {
      for (ApiKeyEntry entry : entries) {
        if (entry == null || entry.keyHash() == null || entry.keyHash().isBlank()) {
          continue;
        }
        String hash = entry.keyHash().trim().toLowerCase(Locale.ROOT);
        byHash.putIfAbsent(hash, principalOf(entry));
      }
    }
    return new ApiKeyAuthenticator(byHash);
  }

  private static Principal principalOf(ApiKeyEntry entry) {
    Set<String> authorities = new LinkedHashSet<>();
    addPrefixed(authorities, "SCOPE_", entry.scopes());
    addPrefixed(authorities, "ROLE_", entry.roles());
    List<GrantedAuthority> granted = new ArrayList<>(authorities.size());
    for (String authority : authorities) {
      granted.add(new SimpleGrantedAuthority(authority));
    }
    String subject =
        (entry.subject() == null || entry.subject().isBlank()) ? "api-key" : entry.subject();
    return new Principal(subject, List.copyOf(granted));
  }

  private static void addPrefixed(Set<String> out, String prefix, List<String> values) {
    if (values == null) {
      return;
    }
    for (String value : values) {
      if (value != null && !value.isBlank()) {
        out.add(prefix + value.trim());
      }
    }
  }

  /**
   * Verify {@code presentedKey} and return its authenticated {@link
   * org.springframework.security.core.Authentication}; throws {@link BadCredentialsException} if
   * the key is unknown. Lookup is by SHA-256 digest; because the key is high-entropy the hashed
   * lookup is not a practical timing oracle for the key's contents.
   */
  public PreAuthenticatedAuthenticationToken authenticate(String presentedKey) {
    Principal principal = (presentedKey == null) ? null : byHash.get(hashApiKey(presentedKey));
    if (principal == null) {
      throw new BadCredentialsException("invalid api key");
    }
    // The three-argument constructor marks the token authenticated; "N/A" stands in for credentials
    // that are not retained after verification.
    return new PreAuthenticatedAuthenticationToken(
        principal.subject(), "N/A", principal.authorities());
  }

  /** Return the lowercase SHA-256 hex digest used to store and look up an API key. */
  public static String hashApiKey(String key) {
    try {
      byte[] digest =
          MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
      return HexFormat.of().formatHex(digest);
    } catch (NoSuchAlgorithmException e) {
      // SHA-256 is mandated by every JVM; its absence is not a recoverable condition.
      throw new IllegalStateException("SHA-256 is unavailable", e);
    }
  }
}
