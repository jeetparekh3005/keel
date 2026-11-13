package io.keel.core.auth;

import io.keel.core.config.KeelProperties;
import io.keel.core.domain.ErrorCategory;
import io.keel.core.web.ProblemSupport;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;

/**
 * The deny-by-default security chain. {@code anyRequest().authenticated()} makes every route
 * require a verified caller except the explicitly permitted health probes; scopes are enforced per
 * route with {@code @PreAuthorize("hasAuthority('SCOPE_...')")}. Tokens are verified by a {@link
 * NimbusJwtDecoder} reading the issuer's JWKS, which caches and refreshes the key set natively
 * (rotation-tolerant). 401/403 are rendered as RFC 9457 problem+json. The repo's own security
 * headers filter owns response headers, so Spring Security's header writer is disabled.
 */
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

  @Bean
  public SecurityFilterChain securityFilterChain(
      HttpSecurity http, JwtDecoder jwtDecoder, ApiKeyAuthenticator apiKeyAuthenticator)
      throws Exception {
    http.csrf(csrf -> csrf.disable())
        .cors(cors -> cors.disable())
        .headers(headers -> headers.disable())
        .sessionManagement(
            session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(authorize ->
            authorize
                .requestMatchers("/healthz", "/readyz")
                .permitAll()
                .anyRequest()
                .authenticated())
        .oauth2ResourceServer(oauth2 ->
            oauth2.jwt(jwt -> jwt.decoder(jwtDecoder).jwtAuthenticationConverter(authConverter())))
        // The X-API-Key filter runs before the bearer-token filter: when the header is present it
        // verifies the key and sets the authentication (with scope authorities), otherwise the JWT
        // resource server runs unchanged. Deny-by-default and per-route @PreAuthorize scopes apply
        // to the api-key principal exactly as they do to a JWT caller.
        .addFilterBefore(
            new ApiKeyAuthenticationFilter(apiKeyAuthenticator),
            BearerTokenAuthenticationFilter.class)
        .exceptionHandling(handling ->
            handling
                .authenticationEntryPoint((request, response, ex) ->
                    ProblemSupport.write(
                        response, ErrorCategory.UNAUTHENTICATED, request.getRequestURI()))
                .accessDeniedHandler((request, response, ex) ->
                    ProblemSupport.write(
                        response, ErrorCategory.FORBIDDEN, request.getRequestURI())));
    return http.build();
  }

  /**
   * The JWT decoder, verifying RS256 tokens against the issuer's JWKS with iss/aud/exp validation.
   * Conditional so a test can supply its own decoder (a stub) without this one failing on an unset
   * JWKS URI.
   */
  @Bean
  @ConditionalOnMissingBean(JwtDecoder.class)
  public JwtDecoder jwtDecoder(KeelProperties properties) {
    // Fail fast on the auth config that must be present: without an audience a same-issuer
    // token minted for another resource server would be accepted (cross-audience reuse), so
    // require it like the JWKS URI and issuer rather than silently skipping aud binding.
    requireConfigured("KEEL_OIDC_JWKS_URI", properties.oidcJwksUri());
    requireConfigured("KEEL_OIDC_ISSUER", properties.oidcIssuer());
    requireConfigured("KEEL_OIDC_AUDIENCE", properties.oidcAudience());

    NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(properties.oidcJwksUri()).build();
    List<OAuth2TokenValidator<Jwt>> validators = new ArrayList<>();
    validators.add(new JwtTimestampValidator());
    validators.add(new JwtIssuerValidator(properties.oidcIssuer()));
    validators.add(audienceValidator(properties.oidcAudience()));
    decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(validators));
    return decoder;
  }

  /**
   * The API-key authenticator, built from the hashed keys in {@link KeelProperties}. Conditional so
   * a test (or a service) can supply its own set of keys without this one overriding it. With no
   * keys configured it rejects every {@code X-API-Key}, leaving the JWT path as the sole
   * credential.
   */
  @Bean
  @ConditionalOnMissingBean(ApiKeyAuthenticator.class)
  public ApiKeyAuthenticator apiKeyAuthenticator(KeelProperties properties) {
    return ApiKeyAuthenticator.fromProperties(properties.apiKeys());
  }

  private static void requireConfigured(String envVar, String value) {
    if (value == null || value.isEmpty()) {
      throw new IllegalStateException(envVar + " is required to verify tokens");
    }
  }

  private static JwtAuthenticationConverter authConverter() {
    JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
    converter.setJwtGrantedAuthoritiesConverter(new ScopeAuthoritiesConverter());
    return converter;
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
