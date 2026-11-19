package io.keel.core.adapters;

import io.keel.core.ports.SecretProvider;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ScheduledExecutorService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.core.client.config.ClientOverrideConfiguration;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient;
import software.amazon.awssdk.services.secretsmanager.model.GetSecretValueRequest;
import software.amazon.awssdk.services.secretsmanager.model.GetSecretValueResponse;
import software.amazon.awssdk.services.secretsmanager.model.ResourceNotFoundException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Production {@link SecretProvider} backed by AWS Secrets Manager (ADR-0024). A {@link
 * SecretCache.Loader} over the shared {@link SecretCache}: the cache serves {@link #get(String)}
 * synchronously from memory and re-invokes {@link #load()} every {@code
 * KEEL_SECRET_CACHE_TTL_SECONDS}, giving AWS exact functional parity with the OpenBao backend
 * through the same port (same coercion, caching, fail-closed, no-leak).
 *
 * <p>Load: the AWS SDK for Java v2 {@code GetSecretValue(SecretId=KEEL_AWS_SECRET_ID)}; the {@code
 * SecretString} is parsed as a JSON object into the field map (ADR-0023 coercion). One secret holds
 * a JSON object of fields; {@code get(name)} returns field {@code name}. A binary-only secret (no
 * {@code SecretString}) or a non-object JSON payload fails loudly - a secret meant to back {@code
 * get(name)} must be a JSON object. {@code ResourceNotFoundException} yields an empty field map
 * (all absent), mirroring Vault's 404-as-empty. Not-found is not an error; auth failure, permission
 * denied, or a malformed payload fail closed with no fall-through to the environment.
 *
 * <p>Credentials come from the default AWS provider chain (env, IRSA, instance profile, SSO); the
 * region is {@code KEEL_AWS_REGION} when set, else the SDK's own region resolution. The v2 client
 * honors {@code AWS_ENDPOINT_URL_SECRETS_MANAGER} for a local endpoint (LocalStack) with no custom
 * knob. Unlike OpenBao this loader carries no lease logic: the SDK refreshes credentials internally
 * and the core simply re-loads every TTL.
 */
public final class AwsSecretsManagerSecretProvider
    implements SecretProvider, AutoCloseable, SecretCache.Loader {

  private static final Logger log = LoggerFactory.getLogger(AwsSecretsManagerSecretProvider.class);

  /**
   * Resolved {@code KEEL_AWS_*} configuration. {@code secretId} (name or ARN) is required and gates
   * the backend; {@code region} is optional (empty -> SDK default chain); {@code cacheTtl} is the
   * shared {@code KEEL_SECRET_CACHE_TTL_SECONDS}.
   */
  public record Config(String secretId, String region, Duration cacheTtl) {}

  private final ObjectMapper mapper = new ObjectMapper();
  private final SecretsManagerClient client;
  private final String secretId;
  // True only when this provider built the client (the Config constructor), so close() releases it;
  // a test-injected client is owned by the test and must not be closed here.
  private final boolean ownsClient;
  private final SecretCache cache;

  public AwsSecretsManagerSecretProvider(Config config) {
    this(
        buildClient(trimToNull(config.region())),
        requireValue(config.secretId(), "KEEL_AWS_SECRET_ID"),
        config.cacheTtl(),
        true);
  }

  /**
   * Test seam: inject a {@link SecretsManagerClient} (the v2 client is an interface, so a stub or
   * mock returning a canned {@code GetSecretValueResponse} needs no network). The caller owns the
   * injected client's lifecycle.
   */
  AwsSecretsManagerSecretProvider(SecretsManagerClient client, String secretId, Duration cacheTtl) {
    this(client, requireValue(secretId, "KEEL_AWS_SECRET_ID"), cacheTtl, false);
  }

  private AwsSecretsManagerSecretProvider(
      SecretsManagerClient client, String secretId, Duration cacheTtl, boolean ownsClient) {
    this.client = client;
    this.secretId = secretId;
    this.ownsClient = ownsClient;
    // The cache validates the TTL (fail-closed), performs the eager first load via load() below,
    // then refreshes every TTL. Constructed last so every field load() needs is already assigned.
    this.cache = new SecretCache(log, "aws-secrets-manager", this, cacheTtl);
  }

  @Override
  public Optional<String> get(String key) {
    return cache.get(key);
  }

  @Override
  public void close() {
    cache.close();
  }

  @Override
  public void start(ScheduledExecutorService scheduler) {
    // No lease logic: the SDK refreshes credentials internally; the cache's TTL refresh is enough.
  }

  @Override
  public void shutdown() {
    if (ownsClient) {
      client.close();
    }
  }

  /**
   * The {@link SecretCache.Loader} load: fetch the secret, parse its {@code SecretString} as a JSON
   * object, and coerce to the field map. Not-found is an empty map; a binary-only or non-object
   * secret fails loudly. Re-invoked by the cache on every TTL refresh.
   */
  @Override
  public Map<String, String> load() {
    GetSecretValueResponse response;
    try {
      response = client.getSecretValue(GetSecretValueRequest.builder().secretId(secretId).build());
    } catch (ResourceNotFoundException notFound) {
      // Mirror Vault's 404-as-empty: a missing secret is not an error (every get() is absent).
      return Map.of();
    }
    String secretString = response.secretString();
    if (secretString == null) {
      // A binary-only secret cannot back get(name): fail closed rather than silently serving empty.
      throw new IllegalStateException(
          "AWS secret "
              + secretId
              + " has no SecretString (binary-only secrets are not supported)");
    }
    JsonNode root = parse(secretString);
    if (!root.isObject()) {
      throw new IllegalStateException("AWS secret " + secretId + " is not a JSON object of fields");
    }
    return SecretCache.coerceFieldMap(root);
  }

  private JsonNode parse(String body) {
    try {
      return mapper.readTree(body);
    } catch (RuntimeException ex) {
      // The parser's exception can echo the payload (secret material) into its message; refresh()
      // logs it, so re-throw a sanitized error carrying only the secret id, never the value
      // (ADR-0023/0024: no secret value in any log/error).
      throw new IllegalStateException("AWS secret " + secretId + " is not valid JSON");
    }
  }

  private static SecretsManagerClient buildClient(String region) {
    var builder =
        SecretsManagerClient.builder()
            .httpClientBuilder(
                UrlConnectionHttpClient.builder()
                    .connectionTimeout(Duration.ofSeconds(5))
                    .socketTimeout(Duration.ofSeconds(10)))
            .overrideConfiguration(hardTimeoutConfiguration());
    if (region != null) {
      builder.region(Region.of(region));
    }
    return builder.build();
  }

  /**
   * Bounded HTTP-timeout + capped-retry override for the production client (ADR-0023's
   * hard-HTTP-timeout rule, as already applied to the OpenBao adapter). {@link
   * UrlConnectionHttpClient} carries a socket timeout, but under the SDK's default retry budget a
   * missing or blackholed Secrets Manager endpoint still stalls startup for a multi-attempt
   * multiple of that timeout rather than failing fast. This caps the whole {@code GetSecretValue}
   * call at 15s, each attempt at 10s, and the retry budget at 2 total attempts so a wedged endpoint
   * cannot multiply the per-attempt stall across many retries - the eager first load fails closed
   * and promptly instead of blocking boot.
   */
  static ClientOverrideConfiguration hardTimeoutConfiguration() {
    return ClientOverrideConfiguration.builder()
        .apiCallTimeout(Duration.ofSeconds(15))
        .apiCallAttemptTimeout(Duration.ofSeconds(10))
        .retryStrategy(r -> r.maxAttempts(2))
        .build();
  }

  private static String requireValue(String value, String name) {
    String trimmed = trimToNull(value);
    if (trimmed == null) {
      throw new IllegalStateException(name + " must be set");
    }
    return trimmed;
  }

  private static String trimToNull(String value) {
    if (value == null) {
      return null;
    }
    String trimmed = value.strip();
    return trimmed.isEmpty() ? null : trimmed;
  }
}
