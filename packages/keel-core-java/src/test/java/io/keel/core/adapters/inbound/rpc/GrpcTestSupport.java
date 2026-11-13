package io.keel.core.adapters.inbound.rpc;

import io.grpc.Metadata;
import java.time.Instant;
import java.util.Map;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/**
 * Test helpers for the gRPC auth tests. The "token" strings are opaque test handles, not real JWTs:
 * the stub decoder maps them to minted {@link Jwt} objects so the tests exercise the real {@link
 * io.keel.core.auth.ScopeAuthoritiesConverter} and interceptor without a signed token or an issuer.
 */
final class GrpcTestSupport {

  static final String READ_TOKEN = "test-read";
  static final String WRITE_TOKEN = "test-write";

  static final Metadata.Key<String> AUTHORIZATION =
      Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);

  private GrpcTestSupport() {}

  /**
   * A decoder that recognizes two opaque handles: {@link #READ_TOKEN} (scope {@code items:read})
   * and {@link #WRITE_TOKEN} (scopes {@code items:read items:write}); everything else is rejected.
   */
  static JwtDecoder stubDecoder() {
    Map<String, Jwt> known =
        Map.of(
            READ_TOKEN, mint("svc-read", "items:read"),
            WRITE_TOKEN, mint("svc-write", "items:read items:write"));
    return token -> {
      Jwt jwt = known.get(token);
      if (jwt == null) {
        throw new BadJwtException("unknown test token");
      }
      return jwt;
    };
  }

  /** Mint a verified {@link Jwt} carrying the given subject and space-delimited scopes. */
  static Jwt mint(String subject, String scopes) {
    return Jwt.withTokenValue("minted-" + subject)
        .header("alg", "none")
        .subject(subject)
        .claim("scope", scopes)
        .issuedAt(Instant.now())
        .expiresAt(Instant.now().plusSeconds(300))
        .build();
  }

  /** Metadata carrying a Bearer authorization header for the given token. */
  static Metadata bearer(String token) {
    Metadata md = new Metadata();
    md.put(AUTHORIZATION, "Bearer " + token);
    return md;
  }
}
