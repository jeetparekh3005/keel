package io.keel.core.adapters;

import com.google.api.gax.retrying.RetrySettings;
import com.google.api.gax.rpc.ApiException;
import com.google.api.gax.rpc.StatusCode;
import com.google.cloud.secretmanager.v1.AccessSecretVersionResponse;
import com.google.cloud.secretmanager.v1.SecretManagerServiceClient;
import com.google.cloud.secretmanager.v1.SecretManagerServiceSettings;
import io.keel.core.ports.SecretProvider;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ScheduledExecutorService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Production {@link SecretProvider} backed by GCP Secret Manager (ADR-0024). A {@link
 * SecretCache.Loader} over the shared {@link SecretCache}: the cache serves {@link #get(String)}
 * synchronously from memory and re-invokes {@link #load()} every {@code
 * KEEL_SECRET_CACHE_TTL_SECONDS}, giving GCP exact functional parity with the OpenBao and AWS
 * backends through the same port (same coercion, caching, fail-closed, no-leak).
 *
 * <p>Load: the Google Cloud client library {@code
 * AccessSecretVersion(name=.../versions/<version>)}; the payload's {@code data} is decoded UTF-8
 * and parsed as a JSON object into the field map (ADR-0023 coercion). One secret holds a JSON
 * object of fields; {@code get(name)} returns field {@code name}. A non-object JSON payload or a
 * binary/non-UTF-8 payload that does not parse fails loudly - a secret meant to back {@code
 * get(name)} must be a JSON object. A {@code NOT_FOUND} (the secret or version does not exist)
 * yields an empty field map (all absent), mirroring Vault's 404-as-empty. Not-found is not an
 * error; auth failure, permission denied, or a malformed payload fail closed with no fall-through
 * to the environment.
 *
 * <p>Credentials come from Application Default Credentials (env, Workload Identity, metadata
 * server); only the secret resource name and version are configured. Unlike OpenBao this loader
 * carries no lease logic: the SDK refreshes credentials internally and the core simply re-loads
 * every TTL.
 *
 * <p>The production client's {@code accessSecretVersion} call settings carry a bounded {@link
 * RetrySettings} ({@link #boundedRetrySettings()}): a 15s total timeout, a 10s per-RPC timeout, and
 * a 2-attempt cap, so a wedged or unreachable Secret Manager - or a degraded ADC/metadata server -
 * fails the eager startup load fast rather than stalling boot under the SDK's generous default
 * retry budget (the GCP analog of ADR-0023's hard-HTTP-timeout rule already applied to AWS).
 */
public final class GcpSecretManagerSecretProvider
    implements SecretProvider, AutoCloseable, SecretCache.Loader {

  private static final Logger log = LoggerFactory.getLogger(GcpSecretManagerSecretProvider.class);

  /**
   * Resolved {@code KEEL_GCP_*} configuration. {@code secret} (gates the backend) is either {@code
   * projects/<project>/secrets/<name>} or the full {@code .../versions/<v>}; {@code version}
   * (default {@code latest}) is appended when {@code secret} names no version; {@code cacheTtl} is
   * the shared {@code KEEL_SECRET_CACHE_TTL_SECONDS}.
   */
  public record Config(String secret, String version, Duration cacheTtl) {}

  private final ObjectMapper mapper = new ObjectMapper();
  private final SecretManagerServiceClient client;
  private final String resourceName;
  // True only when this provider built the client (the Config constructor), so close() releases it;
  // a test-injected client is owned by the test and must not be closed here.
  private final boolean ownsClient;
  private final SecretCache cache;

  public GcpSecretManagerSecretProvider(Config config) {
    this(
        buildClient(),
        resolveResourceName(requireValue(config.secret(), "KEEL_GCP_SECRET"), config.version()),
        config.cacheTtl(),
        true);
  }

  /**
   * Test seam: inject a {@link SecretManagerServiceClient} (a Mockito mock returning a canned
   * {@code AccessSecretVersionResponse}) so no network, metadata-server, or ADC lookup happens. The
   * caller owns the injected client's lifecycle. {@code secret} is the already-resolved resource
   * name (or a {@code projects/.../secrets/<name>} to which the default {@code latest} version is
   * appended).
   */
  GcpSecretManagerSecretProvider(
      SecretManagerServiceClient client, String secret, Duration cacheTtl) {
    this(
        client,
        resolveResourceName(requireValue(secret, "KEEL_GCP_SECRET"), null),
        cacheTtl,
        false);
  }

  private GcpSecretManagerSecretProvider(
      SecretManagerServiceClient client,
      String resourceName,
      Duration cacheTtl,
      boolean ownsClient) {
    this.client = client;
    this.resourceName = resourceName;
    this.ownsClient = ownsClient;
    // The cache validates the TTL (fail-closed), performs the eager first load via load() below,
    // then refreshes every TTL. Constructed last so every field load() needs is already assigned.
    this.cache = new SecretCache(log, "gcp-secret-manager", this, cacheTtl);
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
   * The {@link SecretCache.Loader} load: access the secret version, decode its payload UTF-8, parse
   * it as a JSON object, and coerce to the field map. A {@code NOT_FOUND} is an empty map; a
   * non-object or non-UTF-8/malformed payload fails loudly. Re-invoked by the cache on every TTL
   * refresh.
   */
  @Override
  public Map<String, String> load() {
    AccessSecretVersionResponse response;
    try {
      response = client.accessSecretVersion(resourceName);
    } catch (ApiException ex) {
      StatusCode status = ex.getStatusCode();
      if (status != null && status.getCode() == StatusCode.Code.NOT_FOUND) {
        // Mirror Vault's 404-as-empty: a missing secret/version is not an error (every get()
        // absent).
        return Map.of();
      }
      // Any other API failure (permission denied, unauthenticated, unavailable) fails closed. The
      // gax exception message carries no secret value, so it is safe to propagate for the log.
      throw ex;
    }
    String payload = response.getPayload().getData().toStringUtf8();
    JsonNode root = parse(payload);
    if (!root.isObject()) {
      throw new IllegalStateException(
          "GCP secret " + resourceName + " is not a JSON object of fields");
    }
    return SecretCache.coerceFieldMap(root);
  }

  private JsonNode parse(String body) {
    try {
      return mapper.readTree(body);
    } catch (RuntimeException ex) {
      // The parser's exception can echo the payload (secret material, or binary rendered as a
      // mojibake string) into its message; refresh() logs it, so re-throw a sanitized error
      // carrying
      // only the secret resource name, never the value (ADR-0023/0024: no secret value in any
      // log/error).
      throw new IllegalStateException("GCP secret " + resourceName + " is not valid JSON");
    }
  }

  private static SecretManagerServiceClient buildClient() {
    try {
      SecretManagerServiceSettings.Builder builder = SecretManagerServiceSettings.newBuilder();
      // Bound the eager-load call so a wedged/unreachable Secret Manager or a degraded ADC/metadata
      // server fails startup fast (see the class doc and boundedRetrySettings()).
      builder.accessSecretVersionSettings().setRetrySettings(boundedRetrySettings());
      return SecretManagerServiceClient.create(builder.build());
    } catch (IOException ex) {
      // Credentials/transport could not be initialized (e.g. no ADC resolvable): fail closed at
      // construction rather than silently falling through to the environment.
      throw new UncheckedIOException("cannot initialize the GCP Secret Manager client", ex);
    }
  }

  /**
   * Bounded retry/timeout settings for the production client's {@code accessSecretVersion} call
   * (ADR-0024, the GCP analog of the AWS adapter's hard-HTTP-timeout rule). The SDK's default
   * UnaryCall retry budget would let an unreachable Secret Manager or a stalled ADC/metadata lookup
   * block the eager first load far longer than a boot should tolerate; this caps the whole call at
   * 15s, each RPC attempt at 10s, and the attempt budget at 2 (one retry) so the eager load fails
   * closed and promptly instead of hanging startup.
   */
  static RetrySettings boundedRetrySettings() {
    return RetrySettings.newBuilder()
        .setTotalTimeoutDuration(Duration.ofSeconds(15))
        .setMaxAttempts(2)
        .setInitialRpcTimeoutDuration(Duration.ofSeconds(10))
        .setMaxRpcTimeoutDuration(Duration.ofSeconds(10))
        .build();
  }

  /**
   * Build the version resource name to access. {@code KEEL_GCP_SECRET} may already name a version
   * ({@code .../versions/<v>}), in which case it is used verbatim; otherwise {@code
   * KEEL_GCP_SECRET_VERSION} (default {@code latest}) is appended to the {@code
   * projects/<project>/secrets/<name>} base.
   */
  private static String resolveResourceName(String secret, String version) {
    if (secret.contains("/versions/")) {
      return secret;
    }
    String resolvedVersion = orDefault(version, "latest");
    return secret + "/versions/" + resolvedVersion;
  }

  private static String requireValue(String value, String name) {
    String trimmed = trimToNull(value);
    if (trimmed == null) {
      throw new IllegalStateException(name + " must be set");
    }
    return trimmed;
  }

  private static String orDefault(String value, String fallback) {
    String trimmed = trimToNull(value);
    return trimmed == null ? fallback : trimmed;
  }

  private static String trimToNull(String value) {
    if (value == null) {
      return null;
    }
    String trimmed = value.strip();
    return trimmed.isEmpty() ? null : trimmed;
  }
}
