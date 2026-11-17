package io.keel.core;

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
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

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
   * The production OpenBao/Vault secret backend (ADR-0023), wired only when {@code keel.vault-addr}
   * (env {@code KEEL_VAULT_ADDR}) is set. Declared before the env fallback so, when a Vault address
   * is configured, the {@code @ConditionalOnMissingBean} env bean backs off and this provider wins
   * - fail-closed, no silent fall-through to the environment. {@code destroyMethod = "close"} stops
   * the background refresh thread at shutdown.
   */
  @Bean(destroyMethod = "close")
  @ConditionalOnProperty(prefix = "keel", name = "vault-addr")
  public SecretProvider openBaoSecretProvider(KeelProperties properties) {
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
            java.time.Duration.ofSeconds(properties.vaultCacheTtlSeconds())));
  }

  @Bean
  @ConditionalOnMissingBean
  public SecretProvider secretProvider() {
    return new EnvSecretProvider();
  }
}
