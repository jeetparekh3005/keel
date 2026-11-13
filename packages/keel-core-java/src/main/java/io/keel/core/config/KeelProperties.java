package io.keel.core.config;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Typed, fail-fast configuration bound from the {@code KEEL_*} environment (platform.yaml config:
 * typed, fail-fast). Spring's relaxed binding maps the same env vars the other verticals use:
 * {@code KEEL_OIDC_JWKS_URI} -> {@code keel.oidc-jwks-uri} -> {@code oidcJwksUri}, {@code
 * KEEL_CORS_ALLOW_ORIGINS} (comma-separated) -> a list, etc.
 *
 * <p>Port, log level, service identity, and the OTLP endpoint are bridged to Spring's own
 * properties in application.yml; this record holds what Spring does not model natively.
 *
 * <p>The NATS fields gate the JetStream {@code MessageBus} adapter: it is wired only when {@code
 * KEEL_NATS_URL} ({@code keel.nats-url}) is set, so a service without a broker is unaffected.
 * {@code KEEL_NATS_STREAM} and {@code KEEL_NATS_SUBJECTS} (comma-separated) name the stream and the
 * subjects it captures.
 */
@ConfigurationProperties(prefix = "keel")
@Validated
public record KeelProperties(
    @DefaultValue("") String oidcIssuer,
    @DefaultValue("") String oidcAudience,
    @DefaultValue("") String oidcJwksUri,
    @DefaultValue("postgres://localhost/keel") String databaseUrl,
    @DefaultValue("1048576") long maxBodyBytes,
    @DefaultValue List<String> corsAllowOrigins,
    @DefaultValue List<ApiKeyEntry> apiKeys,
    @DefaultValue("") String natsUrl,
    @DefaultValue("keel") String natsStream,
    @DefaultValue({"keel.>"}) List<String> natsSubjects) {

  /**
   * One configured API-key credential (platform.yaml auth: api_key). The key is stored only as its
   * SHA-256 hex digest ({@code keyHash}) so plaintext never lands in config or memory; the
   * presented key is hashed and compared. {@code subject} identifies the caller and {@code
   * scopes}/{@code roles} become the {@code SCOPE_*}/{@code ROLE_*} authorities enforced per route.
   * Bound from {@code KEEL_APIKEYS_0_KEYHASH}, {@code KEEL_APIKEYS_0_SUBJECT}, {@code
   * KEEL_APIKEYS_0_SCOPES}, etc.
   */
  public record ApiKeyEntry(
      @DefaultValue("") String keyHash,
      @DefaultValue("") String subject,
      @DefaultValue List<String> scopes,
      @DefaultValue List<String> roles) {}
}
