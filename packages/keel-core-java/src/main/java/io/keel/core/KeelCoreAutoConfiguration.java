package io.keel.core;

import io.keel.core.adapters.AwsSecretsManagerSecretProvider;
import io.keel.core.adapters.EnvSecretProvider;
import io.keel.core.adapters.OpenBaoSecretProvider;
import io.keel.core.adapters.SystemClock;
import io.keel.core.auth.SecurityConfig;
import io.keel.core.config.KeelProperties;
import io.keel.core.ports.Clock;
import io.keel.core.ports.SecretProvider;
import io.keel.core.web.BodyLimitFilter;
import io.keel.core.web.DenyByDefaultCorsFilter;
import io.keel.core.web.HealthController;
import io.keel.core.web.ProblemExceptionHandler;
import io.keel.core.web.ReadinessCheck;
import io.keel.core.web.RequestIdFilter;
import io.keel.core.web.SecurityHeadersFilter;
import java.time.Duration;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Lazy;

/**
 * The composition auto-configuration for the Java vertical: it registers the deny-by-default
 * security chain, the RFC 9457 exception handler, the health probes, and the edge filters (security
 * headers, request-id, deny-by-default CORS, body limit) so a service that depends on keel-core is
 * wired without boilerplate (ADR-0009 Tier 1, ADR-0020). The edge filters run before the Spring
 * Security chain (negative orders) so headers decorate even a 401 and CORS preflight is answered
 * without authentication.
 */
@AutoConfiguration
@EnableConfigurationProperties(KeelProperties.class)
@Import({SecurityConfig.class, ProblemExceptionHandler.class, HealthController.class})
public class KeelCoreAutoConfiguration {

  @Bean
  public FilterRegistrationBean<SecurityHeadersFilter> securityHeadersFilter() {
    FilterRegistrationBean<SecurityHeadersFilter> registration =
        new FilterRegistrationBean<>(new SecurityHeadersFilter());
    registration.setOrder(-200);
    return registration;
  }

  @Bean
  public FilterRegistrationBean<RequestIdFilter> requestIdFilter() {
    FilterRegistrationBean<RequestIdFilter> registration =
        new FilterRegistrationBean<>(new RequestIdFilter());
    registration.setOrder(-190);
    return registration;
  }

  @Bean
  public FilterRegistrationBean<DenyByDefaultCorsFilter> corsFilter(KeelProperties properties) {
    FilterRegistrationBean<DenyByDefaultCorsFilter> registration =
        new FilterRegistrationBean<>(new DenyByDefaultCorsFilter(properties.corsAllowOrigins()));
    registration.setOrder(-180);
    return registration;
  }

  @Bean
  public FilterRegistrationBean<BodyLimitFilter> bodyLimitFilter(KeelProperties properties) {
    FilterRegistrationBean<BodyLimitFilter> registration =
        new FilterRegistrationBean<>(new BodyLimitFilter(properties.maxBodyBytes()));
    registration.setOrder(-170);
    return registration;
  }

  /** A default always-ready check; a service overrides this with a real dependency ping. */
  @Bean
  @ConditionalOnMissingBean
  public ReadinessCheck readinessCheck() {
    return () -> true;
  }

  @Bean
  @ConditionalOnMissingBean
  public Clock clock() {
    return new SystemClock();
  }

  /**
   * The secret backend (ADR-0023, ADR-0024). A single factory selects among the dev {@link
   * EnvSecretProvider}, the {@link OpenBaoSecretProvider}, and the {@link
   * AwsSecretsManagerSecretProvider} by which gating property is set: at most one of {@code
   * keel.vault-addr} ({@code KEEL_VAULT_ADDR}) and {@code keel.aws-secret-id} ({@code
   * KEEL_AWS_SECRET_ID}) may be non-blank. Blank or whitespace-only values are treated as unset
   * (matching the other verticals, so a bound-but-empty address never activates a backend and
   * crashes startup); more than one set is an ambiguous misconfiguration that fails construction;
   * none set falls back to the environment. A selected production backend then fails loudly on
   * misconfiguration (fail-closed, no silent fall-through to the environment). {@code
   * KEEL_SECRET_CACHE_TTL_SECONDS} is the shared cache TTL for both backends.
   *
   * <p>{@code @Lazy}: the provider is built on first injection, not at context refresh. The only
   * in-process consumer is the gRPC/mTLS wiring (gated on {@code keel.grpc-port}); a service that
   * reads no secret material never stands up a backend, so a test or app that merely has a secret
   * env var in scope is not forced to construct and validate it. A real consumer still triggers
   * fail-closed construction at startup (ADR-0023: "fails at construction or first read").
   * {@code @ConditionalOnMissingBean} lets a service supply its own provider; the inferred destroy
   * method stops a backend's background refresh thread at shutdown (both are {@link
   * AutoCloseable}).
   */
  @Bean
  @Lazy
  @ConditionalOnMissingBean
  public SecretProvider secretProvider(KeelProperties properties) {
    String vaultAddr = trimToNull(properties.vaultAddr());
    String awsSecretId = trimToNull(properties.awsSecretId());

    int configured = 0;
    if (vaultAddr != null) {
      configured++;
    }
    if (awsSecretId != null) {
      configured++;
    }
    if (configured > 1) {
      throw new IllegalStateException(
          "multiple secret backends configured: set at most one of KEEL_VAULT_ADDR,"
              + " KEEL_AWS_SECRET_ID");
    }

    Duration cacheTtl = Duration.ofSeconds(properties.secretCacheTtlSeconds());

    if (vaultAddr != null) {
      return new OpenBaoSecretProvider(
          new OpenBaoSecretProvider.Config(
              properties.vaultAddr(),
              properties.vaultToken(),
              properties.vaultRole(),
              properties.vaultK8sMount(),
              properties.vaultK8sJwtPath(),
              properties.vaultMount(),
              properties.vaultPath(),
              properties.vaultNamespace(),
              properties.vaultCacert(),
              cacheTtl));
    }
    if (awsSecretId != null) {
      return new AwsSecretsManagerSecretProvider(
          new AwsSecretsManagerSecretProvider.Config(
              awsSecretId, properties.awsRegion(), cacheTtl));
    }
    return new EnvSecretProvider();
  }

  private static String trimToNull(String value) {
    if (value == null) {
      return null;
    }
    String trimmed = value.strip();
    return trimmed.isEmpty() ? null : trimmed;
  }
}
