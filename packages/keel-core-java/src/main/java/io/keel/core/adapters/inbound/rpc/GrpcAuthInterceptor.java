package io.keel.core.adapters.inbound.rpc;

import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import java.util.Collection;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * The deny-by-default gRPC auth interceptor: the server-side analog of the HTTP security chain in
 * {@link io.keel.core.auth.SecurityConfig} (ADR-0022). It authenticates every call with the same
 * verified-JWT path the HTTP edge uses ({@link JwtDecoder} reading the issuer's JWKS, then {@link
 * io.keel.core.auth.ScopeAuthoritiesConverter} mapping scopes to {@code SCOPE_*} authorities) and,
 * when a method declares required scopes, authorizes it. Because {@link GrpcServerFactory} binds
 * every service through this interceptor, a servicer cannot be exposed unauthenticated:
 * deny-by-default holds by construction.
 *
 * <p>A missing or malformed {@code authorization} metadata entry, or a token the decoder rejects,
 * closes the call with {@link Status#UNAUTHENTICATED}; a verified caller lacking a required scope
 * closes it with {@link Status#PERMISSION_DENIED}. On success the verified {@link
 * JwtAuthenticationToken} is published on the gRPC {@link Context} (see {@link
 * GrpcSecurityContext}) for the servicer, and the call proceeds. Exempt methods (health/reflection)
 * bypass auth entirely.
 */
public final class GrpcAuthInterceptor implements ServerInterceptor {

  private static final Metadata.Key<String> AUTHORIZATION =
      Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);
  private static final String BEARER_PREFIX = "bearer ";

  private final JwtDecoder jwtDecoder;
  private final Converter<Jwt, Collection<GrantedAuthority>> authoritiesConverter;
  private final Map<String, Set<String>> requiredScopesByMethod;
  private final Set<String> exemptMethods;

  /**
   * Bind the verification path and the authorization policy.
   *
   * @param jwtDecoder verifies the bearer token (the same decoder the HTTP resource server uses)
   * @param authoritiesConverter maps the verified JWT to Spring Security authorities
   * @param requiredScopesByMethod full method name ({@code pkg.Service/Method}) to the scopes a
   *     caller must hold. Deny-by-default: a method absent from the map is closed and a verified
   *     caller is denied {@link Status#PERMISSION_DENIED}; a method mapped to an explicit empty set
   *     is open to any authenticated caller. A method that should serve unauthenticated callers
   *     belongs in {@code exemptMethods}, never as a map omission.
   * @param exemptMethods full method names that bypass auth entirely (health/reflection)
   */
  public GrpcAuthInterceptor(
      JwtDecoder jwtDecoder,
      Converter<Jwt, Collection<GrantedAuthority>> authoritiesConverter,
      Map<String, Set<String>> requiredScopesByMethod,
      Set<String> exemptMethods) {
    this.jwtDecoder = jwtDecoder;
    this.authoritiesConverter = authoritiesConverter;
    this.requiredScopesByMethod = Map.copyOf(requiredScopesByMethod);
    this.exemptMethods = Set.copyOf(exemptMethods);
  }

  @Override
  public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
      ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
    String method = call.getMethodDescriptor().getFullMethodName();
    if (exemptMethods.contains(method)) {
      return next.startCall(call, headers);
    }

    String token = bearerToken(headers);
    if (token == null) {
      return deny(call, Status.UNAUTHENTICATED, "missing or malformed bearer token");
    }

    Jwt jwt;
    try {
      jwt = jwtDecoder.decode(token);
    } catch (JwtException e) {
      return deny(call, Status.UNAUTHENTICATED, "invalid token");
    }

    Collection<GrantedAuthority> authorities = authoritiesConverter.convert(jwt);
    if (!hasRequiredScopes(method, authorities)) {
      return deny(call, Status.PERMISSION_DENIED, "insufficient scope");
    }

    JwtAuthenticationToken authentication = new JwtAuthenticationToken(jwt, authorities);
    Context context =
        Context.current().withValue(GrpcSecurityContext.AUTHENTICATION, authentication);
    return Contexts.interceptCall(context, call, headers, next);
  }

  private boolean hasRequiredScopes(String method, Collection<GrantedAuthority> authorities) {
    // Deny-by-default: a method whose full name is absent from the policy map is closed. Only an
    // explicit entry opens it - an empty set to any authenticated caller, a non-empty set to a
    // caller holding those scopes. Absence (unmapped) must not fall through to "allow".
    if (!requiredScopesByMethod.containsKey(method)) {
      return false;
    }
    Set<String> required = requiredScopesByMethod.get(method);
    if (required.isEmpty()) {
      return true;
    }
    Set<String> held = new HashSet<>();
    if (authorities != null) {
      for (GrantedAuthority authority : authorities) {
        held.add(authority.getAuthority());
      }
    }
    for (String scope : required) {
      if (!held.contains("SCOPE_" + scope)) {
        return false;
      }
    }
    return true;
  }

  private static String bearerToken(Metadata headers) {
    String value = headers.get(AUTHORIZATION);
    if (value == null) {
      return null;
    }
    if (value.toLowerCase(Locale.ROOT).startsWith(BEARER_PREFIX)) {
      String token = value.substring(BEARER_PREFIX.length()).strip();
      return token.isEmpty() ? null : token;
    }
    return null;
  }

  private static <ReqT, RespT> ServerCall.Listener<ReqT> deny(
      ServerCall<ReqT, RespT> call, Status status, String description) {
    call.close(status.withDescription(description), new Metadata());
    return new ServerCall.Listener<>() {};
  }
}
