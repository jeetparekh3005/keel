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
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executors;
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
 * field map into memory once at construction and serves {@link #get(String)} synchronously from
 * that cache. The port's {@code get} is synchronous, so it must never perform I/O; a daemon
 * background refresh re-reads the path every {@code KEEL_VAULT_CACHE_TTL_SECONDS} and, on a {@code
 * 401/403}, re-authenticates and retries once. A failed refresh keeps serving the last good field
 * map and is logged, so a transient OpenBao outage does not take the service down.
 *
 * <p>Fail-closed: once configured (a non-empty {@code KEEL_VAULT_ADDR}), a misconfiguration (no
 * auth, unreachable server, missing path) fails loudly at construction rather than silently falling
 * back to the environment. Selection lives in {@code KeelCoreAutoConfiguration}: this adapter wins
 * over {@link EnvSecretProvider} when {@code keel.vault-addr} is set.
 */
public final class OpenBaoSecretProvider implements SecretProvider, AutoCloseable {

  private static final Logger log = LoggerFactory.getLogger(OpenBaoSecretProvider.class);

  /**
   * Resolved {@code KEEL_VAULT_*} configuration. {@code addr} and {@code path} are required;
   * exactly one of {@code token}/{@code role} authenticates. Empty strings are treated as absent by
   * {@link #trimToNull(String)} at the call site so Spring's {@code @DefaultValue("")} binding maps
   * cleanly to "unset".
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
  private final ScheduledExecutorService scheduler;

  // The upstream reads actually performed (data-path GETs), so a test can prove get() serves from
  // cache without I/O and that a TTL refresh refetches. Reauth retries count as the same logical
  // read, so only the successful/terminal GET per load increments this.
  private final AtomicInteger readCount = new AtomicInteger();

  private volatile String clientToken;
  private volatile Map<String, String> cache = Map.of();

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
    Duration ttl =
        config.cacheTtl() == null || config.cacheTtl().isZero() || config.cacheTtl().isNegative()
            ? Duration.ofSeconds(60)
            : config.cacheTtl();

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

    // Eager first load (may block): authenticate, then populate the cache. Any failure here is
    // fatal - fail-closed, no fall-through to the environment.
    this.clientToken = authenticate();
    this.cache = loadFieldMap();

    this.scheduler =
        Executors.newSingleThreadScheduledExecutor(runnable -> {
          Thread thread = new Thread(runnable, "keel-vault-refresh");
          thread.setDaemon(true);
          return thread;
        });
    long ttlMillis = ttl.toMillis();
    this.scheduler.scheduleAtFixedRate(this::refresh, ttlMillis, ttlMillis, TimeUnit.MILLISECONDS);
  }

  @Override
  public Optional<String> get(String key) {
    // No I/O: serve synchronously from the in-memory field map (ADR-0023).
    return Optional.ofNullable(cache.get(key));
  }

  /** Visible for tests: the number of upstream KV reads performed (proves cache hits avoid I/O). */
  int readCount() {
    return readCount.get();
  }

  @Override
  public void close() {
    scheduler.shutdownNow();
  }

  /**
   * Background refresh: on failure keep the last good field map and log, never crash the service.
   */
  private void refresh() {
    try {
      this.cache = loadFieldMap();
    } catch (RuntimeException ex) {
      log.warn(
          "OpenBao secret refresh failed for {}/{}; serving the last good field map",
          mount,
          path,
          ex);
    }
  }

  /**
   * Resolve a client token (ADR-0023): a static {@code KEEL_VAULT_TOKEN} is used directly;
   * otherwise a Kubernetes login exchanges the service-account JWT for a token. Re-invoked on a
   * 401/403 to re-authenticate (a static token simply surfaces the error on the retry).
   */
  private String authenticate() {
    if (token != null) {
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
    return clientTokenNode.asText();
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
    Map<String, String> fields = new LinkedHashMap<>();
    if (data.isObject()) {
      for (Map.Entry<String, JsonNode> entry : data.properties()) {
        JsonNode value = entry.getValue();
        fields.put(entry.getKey(), value.isTextual() ? value.asText() : value.toString());
      }
    }
    return Map.copyOf(fields);
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
    return mapper.readTree(body);
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
