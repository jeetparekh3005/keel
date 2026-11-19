package io.keel.core.adapters;

import io.keel.core.ports.SecretProvider;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Production {@link SecretProvider} backed by OpenBao (or HashiCorp Vault) over the Vault KV v2
 * HTTP API (ADR-0023). A tiny hand-written client on the JDK {@link HttpClient} - no vault SDK -
 * that authenticates (static token or Kubernetes service-account JWT), then reads one KV v2 path's
 * field map. It is a {@link SecretCache.Loader} over the shared {@link SecretCache} (ADR-0024): the
 * cache serves {@link #get(String)} synchronously from memory and re-invokes {@link #load()} every
 * {@code KEEL_SECRET_CACHE_TTL_SECONDS}; on a {@code 401/403} this loader re-authenticates and
 * retries once. Unlike AWS/GCP, this loader carries Kubernetes-lease renewal: {@link
 * #start(ScheduledExecutorService)} schedules a proactive re-login a renew-skew before the token
 * expires, on the cache's own daemon thread. A failed refresh keeps serving the last good field map
 * and is logged, so a transient OpenBao outage does not take the service down.
 *
 * <p>Fail-closed: once configured (a non-blank {@code KEEL_VAULT_ADDR}), a misconfiguration (no
 * auth, unreachable server, missing path, non-positive cache TTL) fails loudly at construction
 * rather than silently falling back to the environment. Selection lives in {@code
 * KeelCoreAutoConfiguration}: this adapter wins over {@link EnvSecretProvider} when {@code
 * keel.vault-addr} is non-blank; a blank or whitespace-only address is treated as unset and falls
 * back to the environment rather than crashing startup.
 */
public final class OpenBaoSecretProvider
    implements SecretProvider, AutoCloseable, SecretCache.Loader {

  private static final Logger log = LoggerFactory.getLogger(OpenBaoSecretProvider.class);

  /**
   * Resolved {@code KEEL_VAULT_*} configuration. {@code addr} and {@code path} are required;
   * exactly one of {@code token}/{@code role} authenticates. Empty strings are treated as absent by
   * {@link #trimToNull(String)} at the call site so Spring's {@code @DefaultValue("")} binding maps
   * cleanly to "unset". {@code cacheTtl} is the shared {@code KEEL_SECRET_CACHE_TTL_SECONDS}.
   */
  public record Config(
      String addr,
      String token,
      String role,
      String k8sMount,
      String k8sJwtPath,
      String mount,
      String path,
      String namespace,
      String caCert,
      Duration cacheTtl) {}

  private final HttpClient http;
  private final ObjectMapper mapper = new ObjectMapper();
  private final String addr;
  private final String token;
  private final String role;
  private final String k8sMount;
  private final String k8sJwtPath;
  private final String mount;
  private final String path;
  private final String namespace;

  // The shared caching core: owns the in-memory map, the refresh schedule, and the daemon thread.
  private final SecretCache cache;

  // Set in start() to the cache's scheduler so lease renewal runs on the same single daemon thread.
  private volatile ScheduledExecutorService scheduler;

  // The upstream reads actually performed (data-path GETs), so a test can prove get() serves from
  // cache without I/O and that a TTL refresh refetches. Reauth retries count as the same logical
  // read, so only the successful/terminal GET per load increments this.
  private final AtomicInteger readCount = new AtomicInteger();

  private volatile String clientToken;

  // Kubernetes-login token-expiry instant (nanoTime basis) for proactive renewal (ADR-0023).
  // authenticate() derives it from the login's lease_duration; a self-rescheduling renewal task
  // re-logs in a renew-skew before this instant so the token never lapses between the (potentially
  // much longer) cache-TTL refreshes. Zero means "no lease" (a static token or a login that
  // returned no lease_duration), which disables proactive renewal.
  private volatile long tokenExpiryNanos;

  // Renew once roughly a third of the lease remains: early enough to absorb a failed attempt and a
  // retry, late enough to avoid churning the auth backend.
  private static final long RENEW_SKEW_DIVISOR = 3;

  // Fixed backoff between failed renewal attempts so a persistent auth outage cannot busy-loop the
  // scheduler thread (the reactive 401/403 path still re-authenticates on the next read).
  private static final long RENEW_RETRY_BACKOFF_MILLIS = 1_000L;

  public OpenBaoSecretProvider(Config config) {
    this.addr = stripTrailingSlash(requireValue(config.addr(), "KEEL_VAULT_ADDR"));
    this.token = trimToNull(config.token());
    this.role = trimToNull(config.role());
    this.k8sMount = orDefault(config.k8sMount(), "kubernetes");
    this.k8sJwtPath =
        orDefault(config.k8sJwtPath(), "/var/run/secrets/kubernetes.io/serviceaccount/token");
    this.mount = orDefault(config.mount(), "secret");
    this.path = requireValue(config.path(), "KEEL_VAULT_PATH");
    this.namespace = trimToNull(config.namespace());

    if (this.token == null && this.role == null) {
      throw new IllegalStateException(
          "KEEL_VAULT_ADDR is set but no auth is configured: set KEEL_VAULT_TOKEN or"
              + " KEEL_VAULT_ROLE");
    }

    HttpClient.Builder builder = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5));
    SSLContext sslContext = buildSslContext(trimToNull(config.caCert()));
    if (sslContext != null) {
      builder.sslContext(sslContext);
    }
    this.http = builder.build();

    // The cache validates the TTL (fail-closed), performs the eager first load via load() below,
    // then starts lease renewal (start()) and the TTL refresh on one daemon thread. Constructed
    // last so every field this loader uses is already assigned when the cache calls back.
    this.cache = new SecretCache(log, "vault", this, config.cacheTtl());
  }

  @Override
  public Optional<String> get(String key) {
    return cache.get(key);
  }

  /** Visible for tests: the number of upstream KV reads performed (proves cache hits avoid I/O). */
  int readCount() {
    return readCount.get();
  }

  @Override
  public void close() {
    cache.close();
  }

  /**
   * The {@link SecretCache.Loader} load: authenticate on the first call, then read the KV v2 field
   * map (re-authenticating once on a 401/403). Re-invoked by the cache on every TTL refresh.
   */
  @Override
  public Map<String, String> load() {
    if (clientToken == null) {
      this.clientToken = authenticate();
    }
    return loadFieldMap();
  }

  /** Register proactive Kubernetes-lease renewal on the cache's scheduler (ADR-0023). */
  @Override
  public void start(ScheduledExecutorService scheduler) {
    this.scheduler = scheduler;
    scheduleRenewal();
  }

  /**
   * Resolve a client token (ADR-0023): a static {@code KEEL_VAULT_TOKEN} is used directly;
   * otherwise a Kubernetes login exchanges the service-account JWT for a token. Re-invoked on a
   * 401/403 to re-authenticate (a static token simply surfaces the error on the retry).
   */
  private String authenticate() {
    if (token != null) {
      // A static token carries no lease: disable proactive renewal (a 401/403 still re-surfaces).
      this.tokenExpiryNanos = 0L;
      return token;
    }
    String jwt = readJwt();
    ObjectNode body = mapper.createObjectNode();
    body.put("role", role);
    body.put("jwt", jwt);
    String payload = mapper.writeValueAsString(body);
    HttpRequest.Builder request =
        HttpRequest.newBuilder(URI.create(addr + "/v1/auth/" + k8sMount + "/login"))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "application/json")
            .POST(BodyPublishers.ofString(payload, StandardCharsets.UTF_8));
    if (namespace != null) {
      request.header("X-Vault-Namespace", namespace);
    }
    HttpResponse<String> response = send(request.build());
    if (response.statusCode() / 100 != 2) {
      throw new IllegalStateException(
          "OpenBao Kubernetes login failed with HTTP " + response.statusCode());
    }
    JsonNode root = parse(response.body());
    JsonNode clientTokenNode = root.path("auth").path("client_token");
    if (!clientTokenNode.isTextual() || clientTokenNode.asText().isEmpty()) {
      throw new IllegalStateException("OpenBao Kubernetes login returned no auth.client_token");
    }
    // Track the lease so the renewal task can re-login before the token expires. A missing or
    // non-positive lease_duration means a non-expiring token: no proactive renewal.
    JsonNode leaseNode = root.path("auth").path("lease_duration");
    long lease = leaseNode.isNumber() ? leaseNode.asLong() : 0L;
    this.tokenExpiryNanos = lease > 0 ? System.nanoTime() + lease * 1_000_000_000L : 0L;
    return clientTokenNode.asText();
  }

  /**
   * Schedule the next proactive re-login a renew-skew before the current token's expiry (ADR-0023).
   * A no-op for a static token or a lease-less login; otherwise fires at roughly two-thirds of the
   * remaining lease and reschedules itself from the renewed lease.
   */
  private void scheduleRenewal() {
    long expiry = this.tokenExpiryNanos;
    if (role == null || expiry == 0L) {
      return;
    }
    long remainingMillis = Math.max(0L, (expiry - System.nanoTime()) / 1_000_000L);
    long delayMillis = remainingMillis - (remainingMillis / RENEW_SKEW_DIVISOR);
    scheduleRenewalAfter(delayMillis);
  }

  private void scheduleRenewalAfter(long delayMillis) {
    ScheduledExecutorService s = this.scheduler;
    if (s == null) {
      return;
    }
    try {
      s.schedule(this::renewToken, Math.max(0L, delayMillis), TimeUnit.MILLISECONDS);
    } catch (RejectedExecutionException ignored) {
      // The scheduler is shutting down (close()): there is nothing left to renew.
    }
  }

  /**
   * Re-login to refresh the lease, then reschedule from the new lease. A failed attempt keeps the
   * current token and retries after a fixed backoff (not immediately), so a persistent auth outage
   * cannot spin the scheduler thread; the reactive 401/403 path still covers an expired token.
   */
  private void renewToken() {
    try {
      this.clientToken = authenticate();
      scheduleRenewal();
    } catch (RuntimeException ex) {
      // Never leak secret material in the failure log (ADR-0023); the exception carries none.
      log.warn("OpenBao token renewal failed; will retry shortly", ex);
      scheduleRenewalAfter(RENEW_RETRY_BACKOFF_MILLIS);
    }
  }

  private String readJwt() {
    try {
      return Files.readString(Path.of(k8sJwtPath), StandardCharsets.UTF_8).strip();
    } catch (IOException ex) {
      throw new UncheckedIOException(
          "cannot read the Kubernetes service-account JWT at " + k8sJwtPath, ex);
    }
  }

  /**
   * Read the KV v2 field map at {@code {mount}/data/{path}}. A 404 (no secret) is an empty map, not
   * an error - the same as an empty environment. A 401/403 triggers one re-authenticate + retry.
   */
  private Map<String, String> loadFieldMap() {
    HttpResponse<String> response = readPath(clientToken);
    int status = response.statusCode();
    if (status == 401 || status == 403) {
      this.clientToken = authenticate();
      response = readPath(clientToken);
      status = response.statusCode();
    }
    readCount.incrementAndGet();
    if (status == 404) {
      return Map.of();
    }
    if (status / 100 != 2) {
      throw new IllegalStateException(
          "OpenBao read of " + mount + "/data/" + path + " failed with HTTP " + status);
    }
    JsonNode data = parse(response.body()).path("data").path("data");
    return SecretCache.coerceFieldMap(data);
  }

  private HttpResponse<String> readPath(String vaultToken) {
    HttpRequest.Builder request =
        HttpRequest.newBuilder(URI.create(addr + "/v1/" + mount + "/data/" + path))
            .timeout(Duration.ofSeconds(10))
            .header("X-Vault-Token", vaultToken)
            .GET();
    if (namespace != null) {
      request.header("X-Vault-Namespace", namespace);
    }
    return send(request.build());
  }

  private HttpResponse<String> send(HttpRequest request) {
    try {
      return http.send(request, BodyHandlers.ofString(StandardCharsets.UTF_8));
    } catch (IOException ex) {
      throw new UncheckedIOException("OpenBao request to " + request.uri() + " failed", ex);
    } catch (InterruptedException ex) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("interrupted while calling OpenBao", ex);
    }
  }

  private JsonNode parse(String body) {
    try {
      return mapper.readTree(body);
    } catch (RuntimeException ex) {
      // The parser's exception can echo the response body (which may carry secret material) into
      // its message; refresh() logs the exception, so re-throw a sanitized error with neither the
      // body nor the original cause chain (ADR-0023: no secret value in any log/error).
      throw new IllegalStateException("OpenBao returned a malformed JSON response");
    }
  }

  /**
   * Build an SSLContext trusting {@code KEEL_VAULT_CACERT} - a PEM literal or a file path. Null
   * when unset (the JDK default trusts the system roots).
   */
  private static SSLContext buildSslContext(String caCert) {
    if (caCert == null) {
      return null;
    }
    try {
      byte[] pem =
          caCert.contains("BEGIN CERTIFICATE")
              ? caCert.getBytes(StandardCharsets.UTF_8)
              : Files.readAllBytes(Path.of(caCert));
      CertificateFactory factory = CertificateFactory.getInstance("X.509");
      KeyStore trustStore = KeyStore.getInstance(KeyStore.getDefaultType());
      trustStore.load(null, null);
      int index = 0;
      for (var certificate : factory.generateCertificates(new ByteArrayInputStream(pem))) {
        trustStore.setCertificateEntry("keel-vault-ca-" + index++, (X509Certificate) certificate);
      }
      TrustManagerFactory trustManagerFactory =
          TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
      trustManagerFactory.init(trustStore);
      SSLContext sslContext = SSLContext.getInstance("TLS");
      sslContext.init(null, trustManagerFactory.getTrustManagers(), null);
      return sslContext;
    } catch (Exception ex) {
      throw new IllegalStateException("cannot build a TLS trust store from KEEL_VAULT_CACERT", ex);
    }
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

  private static String stripTrailingSlash(String value) {
    return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
  }
}
