package io.keel.core.adapters;

import io.keel.core.ports.SecretProvider;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import tools.jackson.databind.JsonNode;

/**
 * The shared caching core for every production {@link SecretProvider} backend (ADR-0024). It holds
 * the cache/refresh/coercion/no-leak engine that ADR-0023 first grew inside the OpenBao adapter,
 * now parameterized by a {@link Loader} that authenticates and returns the raw field map. OpenBao,
 * AWS Secrets Manager, and GCP Secret Manager are three loaders over this one core, so the three
 * backends cannot diverge on caching, TTL validation, fail-closed loading, or the no-leak refresh
 * log.
 *
 * <p>At construction it validates the TTL (fail-closed on a non-positive value), loads the field
 * map once eagerly (a failure here is fatal - no silent fall-through to the environment), then
 * refreshes on a daemon thread every TTL. {@link #get(String)} performs no I/O: it serves
 * synchronously from the last loaded map, so the port's synchronous contract is honored even on
 * runtimes that cannot block in {@code get}. A failed refresh keeps serving the last good map and
 * is logged under the backend's own logger (passed in so the regression tests that assert a secret
 * never reaches the log capture the right logger), never crashing the service for a transient
 * outage. The log message carries only the backend name - never a secret value, token, or response
 * body; each loader is responsible for sanitizing the exceptions it throws.
 */
final class SecretCache implements SecretProvider, AutoCloseable {

  /**
   * Authenticates (if the backend needs it) and returns the secret's raw field map. Invoked once
   * eagerly at construction and again on every TTL refresh; must throw (never return a partial map)
   * on an auth or read failure so the core can keep serving the last good map. A loader with its
   * own background work (OpenBao's Kubernetes-lease renewal) registers it in {@link
   * #start(ScheduledExecutorService)} against the core's single scheduler, so the whole backend
   * runs on one daemon thread. AWS/GCP loaders carry no lease logic - their SDKs refresh
   * credentials internally - so the core simply re-invokes {@link #load()} every TTL.
   */
  interface Loader {
    Map<String, String> load();

    default void start(ScheduledExecutorService scheduler) {}

    /**
     * Release loader-owned resources (e.g. an SDK client); the core owns and stops the scheduler.
     */
    default void shutdown() {}
  }

  private final Logger log;
  private final String backend;
  private final Loader loader;
  private final ScheduledExecutorService scheduler;

  private volatile Map<String, String> cache = Map.of();

  SecretCache(Logger log, String backend, Loader loader, Duration cacheTtl) {
    this.log = log;
    this.backend = backend;
    this.loader = loader;
    // TTL is normative (ADR-0024): unset -> 60s; a non-positive value is a misconfiguration and
    // fails construction rather than being silently coerced (an unparseable value is already
    // rejected earlier by the int binding in KeelProperties). Validated before the first load so a
    // bad TTL never performs network I/O first.
    Duration ttl;
    if (cacheTtl == null) {
      ttl = Duration.ofSeconds(60);
    } else if (cacheTtl.isZero() || cacheTtl.isNegative()) {
      throw new IllegalStateException("KEEL_SECRET_CACHE_TTL_SECONDS must be a positive integer");
    } else {
      ttl = cacheTtl;
    }

    // Eager first load (may block): fail-closed, a failure here aborts construction.
    this.cache = loader.load();

    this.scheduler =
        Executors.newSingleThreadScheduledExecutor(runnable -> {
          Thread thread = new Thread(runnable, "keel-" + backend + "-refresh");
          thread.setDaemon(true);
          return thread;
        });
    // Let the loader register any background work (e.g. OpenBao lease renewal) on the same thread.
    loader.start(scheduler);
    long ttlMillis = ttl.toMillis();
    this.scheduler.scheduleAtFixedRate(this::refresh, ttlMillis, ttlMillis, TimeUnit.MILLISECONDS);
  }

  @Override
  public Optional<String> get(String key) {
    // No I/O: serve synchronously from the in-memory field map (ADR-0023/0024).
    return Optional.ofNullable(cache.get(key));
  }

  @Override
  public void close() {
    scheduler.shutdownNow();
    loader.shutdown();
  }

  /**
   * Background refresh: on failure keep the last good field map and log, never crash the service.
   * The exception is the loader's (already sanitized of secret material); only the backend name is
   * added to the message.
   */
  private void refresh() {
    try {
      this.cache = loader.load();
    } catch (RuntimeException ex) {
      log.warn("{} secret refresh failed; serving the last good field map", backend, ex);
    }
  }

  /**
   * Coerce a JSON object into a scalar field map (ADR-0023 coercion, shared by every backend). Only
   * a JSON string, number, or boolean is a secret: a string is used verbatim, a number is its JSON
   * text, a boolean is {@code true}/{@code false}. An object, array, or null has no canonical
   * scalar form, so it is dropped and {@code get()} returns empty rather than leaking a serialized
   * blob into a field meant to hold a credential. A non-object node yields an empty map.
   */
  static Map<String, String> coerceFieldMap(JsonNode node) {
    Map<String, String> fields = new LinkedHashMap<>();
    if (node != null && node.isObject()) {
      for (Map.Entry<String, JsonNode> entry : node.properties()) {
        JsonNode value = entry.getValue();
        if (value.isTextual() || value.isNumber() || value.isBoolean()) {
          fields.put(entry.getKey(), value.asText());
        }
      }
    }
    return Map.copyOf(fields);
  }
}
