package io.keel.core.auth;

import io.keel.core.domain.ErrorCategory;
import io.keel.core.web.ProblemSupport;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Authenticates a caller presenting an {@code X-API-Key} header, mirroring the Python {@code
 * _extract_credential} preference (Bearer JWT or {@code X-API-Key}). Registered ahead of the
 * resource-server's bearer-token filter in {@link SecurityConfig}:
 *
 * <ul>
 *   <li>No {@code X-API-Key} header: the chain proceeds and the JWT resource server runs as before.
 *   <li>A valid key: the {@link SecurityContext} is populated with a principal carrying the key's
 *       scope/role authorities, so deny-by-default ({@code anyRequest().authenticated()}) is
 *       satisfied and the per-route {@code @PreAuthorize} scope check still decides access (a
 *       missing scope yields 403 via the access-denied handler).
 *   <li>An invalid key: a 401 problem+json is written and the chain stops; a bad key never falls
 *       through to the JWT path.
 * </ul>
 */
public final class ApiKeyAuthenticationFilter extends OncePerRequestFilter {

  /** The header carrying the opaque API key (matches the Python vertical and platform.yaml). */
  public static final String HEADER = "X-API-Key";

  private final ApiKeyAuthenticator authenticator;

  public ApiKeyAuthenticationFilter(ApiKeyAuthenticator authenticator) {
    this.authenticator = authenticator;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {
    String apiKey = request.getHeader(HEADER);
    if (apiKey == null || apiKey.isBlank()) {
      // No API key presented: leave the context untouched so the JWT resource server can run.
      filterChain.doFilter(request, response);
      return;
    }
    PreAuthenticatedAuthenticationToken authentication;
    try {
      authentication = authenticator.authenticate(apiKey);
    } catch (AuthenticationException ex) {
      // A presented-but-invalid key is a hard 401; it must not fall through to the bearer path.
      SecurityContextHolder.clearContext();
      ProblemSupport.write(response, ErrorCategory.UNAUTHENTICATED, request.getRequestURI());
      return;
    }
    SecurityContext context = SecurityContextHolder.createEmptyContext();
    context.setAuthentication(authentication);
    SecurityContextHolder.setContext(context);
    try {
      filterChain.doFilter(request, response);
    } finally {
      // Stateless: never let an authentication leak onto a pooled thread's next request.
      SecurityContextHolder.clearContext();
    }
  }
}
