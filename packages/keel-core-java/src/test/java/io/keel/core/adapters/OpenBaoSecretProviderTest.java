package io.keel.core.adapters;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.StackTraceElementProxy;
import ch.qos.logback.core.read.ListAppender;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

/**
 * Unit coverage for the OpenBao KV v2 adapter (ADR-0023) against an in-process {@link HttpServer}
 * mock - no real server and no vault SDK. Proves request shape (paths, the {@code X-Vault-Token}
 * and {@code X-Vault-Namespace} headers, the Kubernetes login body), that a known secret
 * round-trips, that {@link OpenBaoSecretProvider#get} serves from cache without I/O, TTL refresh,
 * 404-as-empty, 403-reauth-and-retry, and fail-closed construction on misconfig.
 */
class OpenBaoSecretProviderTest {

  private HttpServer server;
  private OpenBaoSecretProvider provider;
  private Logger capturedLogger;
  private ListAppender<ILoggingEvent> logAppender;

  @AfterEach
  void tearDown() {
    if (provider != null) {
      provider.close();
      provider = null;
    }
    if (server != null) {
      server.stop(0);
      server = null;
    }
    if (capturedLogger != null && logAppender != null) {
      capturedLogger.detachAppender(logAppender);
      capturedLogger = null;
      logAppender = null;
    }
  }

  /** Attach a list appender to the adapter's logger so a test can inspect what it logs. */
  private ListAppender<ILoggingEvent> captureAdapterLog() {
    capturedLogger = (Logger) LoggerFactory.getLogger(OpenBaoSecretProvider.class);
    logAppender = new ListAppender<>();
    logAppender.start();
    capturedLogger.addAppender(logAppender);
    return logAppender;
  }

  /**
   * Flatten every captured event - message, throwable chain, and stack - into one searchable
   * string.
   */
  private static String renderLog(ListAppender<ILoggingEvent> appender) {
    StringBuilder sb = new StringBuilder();
    for (ILoggingEvent event : new ArrayList<>(appender.list)) {
      sb.append(event.getFormattedMessage()).append('\n');
      for (IThrowableProxy t = event.getThrowableProxy(); t != null; t = t.getCause()) {
        sb.append(t.getClassName()).append(' ').append(t.getMessage()).append('\n');
        for (StackTraceElementProxy frame : t.getStackTraceElementProxyArray()) {
          sb.append(frame.getSTEAsString()).append('\n');
        }
      }
    }
    return sb.toString();
  }

  private String start(String context, HttpHandler handler) throws IOException {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(context, handler);
    server.start();
    return "http://127.0.0.1:" + server.getAddress().getPort();
  }

  private String start(List<String> contexts, List<HttpHandler> handlers) throws IOException {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    for (int i = 0; i < contexts.size(); i++) {
      server.createContext(contexts.get(i), handlers.get(i));
    }
    server.start();
    return "http://127.0.0.1:" + server.getAddress().getPort();
  }

  private static void respond(HttpExchange exchange, int status, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().add("Content-Type", "application/json");
    exchange.sendResponseHeaders(status, bytes.length);
    exchange.getResponseBody().write(bytes);
    exchange.close();
  }

  private static String readBody(HttpExchange exchange) throws IOException {
    return new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
  }

  private OpenBaoSecretProvider.Config config(String addr, String token, String path) {
    return new OpenBaoSecretProvider.Config(
        addr, token, null, null, null, "secret", path, null, null, Duration.ofSeconds(60));
  }

  @Test
  void tokenAuthReadRoundTripsAKnownSecret() throws Exception {
    List<String> seenTokens = new ArrayList<>();
    String addr =
        start(
            "/v1/secret/data/keel-test",
            exchange -> {
              seenTokens.add(exchange.getRequestHeaders().getFirst("X-Vault-Token"));
              respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"s3cret\",\"n\":7}}}");
            });

    provider = new OpenBaoSecretProvider(config(addr, "root", "keel-test"));

    assertEquals(Optional.of("s3cret"), provider.get("api_key"));
    assertEquals(Optional.of("7"), provider.get("n"), "non-string fields serialize to text");
    assertEquals(Optional.empty(), provider.get("missing"));
    assertEquals("root", seenTokens.get(0), "static token sent as X-Vault-Token");
  }

  @Test
  void kubernetesLoginThenRead(@TempDir Path tmp) throws Exception {
    Path jwtFile = tmp.resolve("token");
    Files.writeString(jwtFile, "jwt-abc\n");

    List<String> loginBodies = new ArrayList<>();
    List<String> dataTokens = new ArrayList<>();
    String addr =
        start(
            List.of("/v1/auth/kubernetes/login", "/v1/secret/data/keel-test"),
            List.of(
                exchange -> {
                  loginBodies.add(readBody(exchange));
                  respond(
                      exchange,
                      200,
                      "{\"auth\":{\"client_token\":\"k8s-token\",\"lease_duration\":3600}}");
                },
                exchange -> {
                  dataTokens.add(exchange.getRequestHeaders().getFirst("X-Vault-Token"));
                  respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"from-k8s\"}}}");
                }));

    OpenBaoSecretProvider.Config cfg =
        new OpenBaoSecretProvider.Config(
            addr,
            null,
            "keel",
            "kubernetes",
            jwtFile.toString(),
            "secret",
            "keel-test",
            null,
            null,
            Duration.ofSeconds(60));
    provider = new OpenBaoSecretProvider(cfg);

    assertEquals(Optional.of("from-k8s"), provider.get("api_key"));
    assertEquals(
        "{\"role\":\"keel\",\"jwt\":\"jwt-abc\"}",
        loginBodies.get(0),
        "login body is {role,jwt} with the trimmed JWT file contents");
    assertEquals("k8s-token", dataTokens.get(0), "the login-issued token reads the secret");
  }

  @Test
  void twoGetsHitTheCacheWithOneUpstreamRead() throws Exception {
    AtomicInteger reads = new AtomicInteger();
    String addr =
        start(
            "/v1/secret/data/keel-test",
            exchange -> {
              reads.incrementAndGet();
              respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"cached\"}}}");
            });

    provider = new OpenBaoSecretProvider(config(addr, "root", "keel-test"));

    assertEquals(Optional.of("cached"), provider.get("api_key"));
    assertEquals(Optional.of("cached"), provider.get("api_key"));
    assertEquals(1, reads.get(), "get() serves from cache, performing no I/O");
    assertEquals(1, provider.readCount());
  }

  @Test
  void ttlExpiryRefetchesTheFieldMap() throws Exception {
    AtomicInteger reads = new AtomicInteger();
    String addr =
        start(
            "/v1/secret/data/keel-test",
            exchange -> {
              int n = reads.incrementAndGet();
              respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"v" + n + "\"}}}");
            });

    OpenBaoSecretProvider.Config cfg =
        new OpenBaoSecretProvider.Config(
            addr,
            "root",
            null,
            null,
            null,
            "secret",
            "keel-test",
            null,
            null,
            Duration.ofMillis(150));
    provider = new OpenBaoSecretProvider(cfg);

    assertEquals(Optional.of("v1"), provider.get("api_key"));
    // Wait on the observable value, not the read counter: the background refresh bumps the read
    // count and swaps the cached map as two steps, so a get() taken the instant the counter hits 2
    // can still see "v1" (the swap has not landed yet). Polling until get() returns "v2" removes
    // that race and still fails (via waitUntil's 5s deadline) if the refresh never replaces the map.
    waitUntil(() -> Optional.of("v2").equals(provider.get("api_key")));
    assertEquals(Optional.of("v2"), provider.get("api_key"), "background refresh replaced the map");
  }

  @Test
  void failedRefreshKeepsTheLastGoodMap() throws Exception {
    AtomicInteger reads = new AtomicInteger();
    String addr =
        start(
            "/v1/secret/data/keel-test",
            exchange -> {
              int n = reads.incrementAndGet();
              if (n == 1) {
                respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"good\"}}}");
              } else {
                respond(exchange, 500, "{\"errors\":[\"boom\"]}");
              }
            });

    OpenBaoSecretProvider.Config cfg =
        new OpenBaoSecretProvider.Config(
            addr,
            "root",
            null,
            null,
            null,
            "secret",
            "keel-test",
            null,
            null,
            Duration.ofMillis(150));
    provider = new OpenBaoSecretProvider(cfg);

    assertEquals(Optional.of("good"), provider.get("api_key"));
    waitUntil(() -> reads.get() >= 2);
    assertEquals(
        Optional.of("good"),
        provider.get("api_key"),
        "a failed refresh keeps serving the last good field map");
  }

  @Test
  void missingSecretIsEmptyNotAnError() throws Exception {
    String addr = start("/v1/secret/data/keel-test", exchange -> respond(exchange, 404, "{}"));

    provider = new OpenBaoSecretProvider(config(addr, "root", "keel-test"));

    assertEquals(Optional.empty(), provider.get("api_key"), "404 yields an empty field map");
  }

  @Test
  void forbiddenReauthenticatesAndRetries(@TempDir Path tmp) throws Exception {
    Path jwtFile = tmp.resolve("token");
    Files.writeString(jwtFile, "jwt-abc");

    AtomicInteger logins = new AtomicInteger();
    AtomicInteger reads = new AtomicInteger();
    String addr =
        start(
            List.of("/v1/auth/kubernetes/login", "/v1/secret/data/keel-test"),
            List.of(
                exchange -> {
                  int n = logins.incrementAndGet();
                  respond(
                      exchange,
                      200,
                      "{\"auth\":{\"client_token\":\"tok" + n + "\",\"lease_duration\":3600}}");
                },
                exchange -> {
                  int n = reads.incrementAndGet();
                  if (n == 1) {
                    respond(exchange, 403, "{\"errors\":[\"permission denied\"]}");
                  } else {
                    respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"after-reauth\"}}}");
                  }
                }));

    OpenBaoSecretProvider.Config cfg =
        new OpenBaoSecretProvider.Config(
            addr,
            null,
            "keel",
            "kubernetes",
            jwtFile.toString(),
            "secret",
            "keel-test",
            null,
            null,
            Duration.ofSeconds(60));
    provider = new OpenBaoSecretProvider(cfg);

    assertEquals(Optional.of("after-reauth"), provider.get("api_key"));
    assertEquals(2, logins.get(), "a 403 re-authenticates (initial login + re-login)");
    assertEquals(2, reads.get(), "the read is retried once after re-auth");
  }

  @Test
  void namespaceHeaderIsSentWhenConfigured() throws Exception {
    List<String> namespaces = new ArrayList<>();
    String addr =
        start(
            "/v1/secret/data/keel-test",
            exchange -> {
              namespaces.add(exchange.getRequestHeaders().getFirst("X-Vault-Namespace"));
              respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"ns\"}}}");
            });

    OpenBaoSecretProvider.Config cfg =
        new OpenBaoSecretProvider.Config(
            addr,
            "root",
            null,
            null,
            null,
            "secret",
            "keel-test",
            "team-a",
            null,
            Duration.ofSeconds(60));
    provider = new OpenBaoSecretProvider(cfg);

    assertEquals(Optional.of("ns"), provider.get("api_key"));
    assertEquals("team-a", namespaces.get(0), "X-Vault-Namespace sent when configured");
  }

  @Test
  void failsClosedWhenNoAuthConfigured() {
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () -> new OpenBaoSecretProvider(config("http://127.0.0.1:1", null, "keel-test")));
    assertTrue(ex.getMessage().contains("no auth"), "misconfig fails loudly, no env fall-through");
  }

  @Test
  void failsClosedWhenPathMissing() {
    assertThrows(
        IllegalStateException.class,
        () -> new OpenBaoSecretProvider(config("http://127.0.0.1:1", "root", "")));
  }

  @Test
  void failsClosedWhenServerUnreachable() {
    // Port 1 is not listening: construction must fail loudly rather than fall back to the env.
    assertThrows(
        RuntimeException.class,
        () -> new OpenBaoSecretProvider(config("http://127.0.0.1:1", "root", "keel-test")));
  }

  @Test
  void invalidCaCertFailsConstruction() {
    OpenBaoSecretProvider.Config cfg =
        new OpenBaoSecretProvider.Config(
            "https://127.0.0.1:1",
            "root",
            null,
            null,
            null,
            "secret",
            "keel-test",
            null,
            "-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----",
            Duration.ofSeconds(60));
    assertThrows(IllegalStateException.class, () -> new OpenBaoSecretProvider(cfg));
  }

  @Test
  void proactivelyReLoginsBeforeTheLeaseExpires(@TempDir Path tmp) throws Exception {
    // A short 1s Kubernetes lease with a long cache TTL: the token must be renewed by a proactive
    // re-login well before the (30s) TTL refresh would ever re-read, not only reactively on
    // 401/403.
    Path jwtFile = tmp.resolve("token");
    Files.writeString(jwtFile, "jwt-abc");

    AtomicInteger logins = new AtomicInteger();
    AtomicInteger reads = new AtomicInteger();
    String addr =
        start(
            List.of("/v1/auth/kubernetes/login", "/v1/secret/data/keel-test"),
            List.of(
                exchange -> {
                  logins.incrementAndGet();
                  respond(
                      exchange, 200, "{\"auth\":{\"client_token\":\"k8s\",\"lease_duration\":1}}");
                },
                exchange -> {
                  reads.incrementAndGet();
                  respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"v\"}}}");
                }));

    OpenBaoSecretProvider.Config cfg =
        new OpenBaoSecretProvider.Config(
            addr,
            null,
            "keel",
            "kubernetes",
            jwtFile.toString(),
            "secret",
            "keel-test",
            null,
            null,
            Duration.ofSeconds(30));
    provider = new OpenBaoSecretProvider(cfg);

    assertEquals(Optional.of("v"), provider.get("api_key"));
    waitUntil(() -> logins.get() >= 2);
    assertTrue(logins.get() >= 2, "a near-expiry lease triggers a proactive re-login");
    assertEquals(
        1, provider.readCount(), "renewal re-authenticates but does not re-read before the TTL");
  }

  @Test
  void nonPositiveCacheTtlFailsConstruction() {
    OpenBaoSecretProvider.Config zero =
        new OpenBaoSecretProvider.Config(
            "http://127.0.0.1:1",
            "root",
            null,
            null,
            null,
            "secret",
            "keel-test",
            null,
            null,
            Duration.ZERO);
    IllegalStateException ex =
        assertThrows(IllegalStateException.class, () -> new OpenBaoSecretProvider(zero));
    assertTrue(
        ex.getMessage().contains("KEEL_SECRET_CACHE_TTL_SECONDS"),
        "a zero TTL fails construction rather than being coerced to a default");

    OpenBaoSecretProvider.Config negative =
        new OpenBaoSecretProvider.Config(
            "http://127.0.0.1:1",
            "root",
            null,
            null,
            null,
            "secret",
            "keel-test",
            null,
            null,
            Duration.ofSeconds(-5));
    assertThrows(
        IllegalStateException.class,
        () -> new OpenBaoSecretProvider(negative),
        "a negative TTL fails construction");
  }

  @Test
  void onlyScalarFieldsAreCoercedNonScalarsAreEmpty() throws Exception {
    String addr =
        start(
            "/v1/secret/data/keel-test",
            exchange ->
                respond(
                    exchange,
                    200,
                    "{\"data\":{\"data\":{"
                        + "\"str\":\"s3cret\","
                        + "\"int\":7,"
                        + "\"frac\":1.5,"
                        + "\"yes\":true,"
                        + "\"no\":false,"
                        + "\"obj\":{\"a\":1},"
                        + "\"arr\":[1,2],"
                        + "\"nul\":null}}}"));

    provider = new OpenBaoSecretProvider(config(addr, "root", "keel-test"));

    assertEquals(Optional.of("s3cret"), provider.get("str"));
    assertEquals(Optional.of("7"), provider.get("int"), "a number coerces to its JSON text");
    assertEquals(Optional.of("1.5"), provider.get("frac"));
    assertEquals(Optional.of("true"), provider.get("yes"), "a boolean coerces to true/false");
    assertEquals(Optional.of("false"), provider.get("no"));
    assertEquals(Optional.empty(), provider.get("obj"), "an object has no scalar form -> empty");
    assertEquals(Optional.empty(), provider.get("arr"), "an array has no scalar form -> empty");
    assertEquals(Optional.empty(), provider.get("nul"), "a null has no scalar form -> empty");
  }

  @Test
  void refreshFailureNeverLogsTheSecretOrToken() throws Exception {
    String secret = "top-secret-value-xyz";
    String tok = "root-token-abc";
    AtomicInteger reads = new AtomicInteger();
    String addr =
        start(
            "/v1/secret/data/keel-test",
            exchange -> {
              int n = reads.incrementAndGet();
              if (n == 1) {
                respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"" + secret + "\"}}}");
              } else {
                // The error body echoes the secret: it must never reach the refresh log.
                respond(exchange, 500, "{\"errors\":[\"" + secret + "\"]}");
              }
            });

    ListAppender<ILoggingEvent> appender = captureAdapterLog();
    OpenBaoSecretProvider.Config cfg =
        new OpenBaoSecretProvider.Config(
            addr, tok, null, null, null, "secret", "keel-test", null, null, Duration.ofMillis(100));
    provider = new OpenBaoSecretProvider(cfg);

    assertEquals(Optional.of(secret), provider.get("api_key"));
    waitUntil(() -> reads.get() >= 2);
    waitUntil(() -> !appender.list.isEmpty());
    provider.close(); // quiesce the scheduler before inspecting the captured log

    String logged = renderLog(appender);
    assertFalse(logged.contains(secret), "the secret value must never appear in any log line");
    assertFalse(logged.contains(tok), "the vault token must never appear in any log line");
    assertEquals(
        Optional.of(secret), provider.get("api_key"), "a failed refresh keeps the last good map");
  }

  @Test
  void malformedRefreshResponseDoesNotLogTheBodyOrParserInternals() throws Exception {
    String secret = "top-secret-value-xyz";
    AtomicInteger reads = new AtomicInteger();
    String addr =
        start(
            "/v1/secret/data/keel-test",
            exchange -> {
              int n = reads.incrementAndGet();
              if (n == 1) {
                respond(exchange, 200, "{\"data\":{\"data\":{\"api_key\":\"" + secret + "\"}}}");
              } else {
                // A 2xx with a malformed body embedding the secret: the parser error must be
                // sanitized so neither the body nor the raw parser exception reaches the log.
                respond(exchange, 200, "{not json " + secret + "}");
              }
            });

    ListAppender<ILoggingEvent> appender = captureAdapterLog();
    OpenBaoSecretProvider.Config cfg =
        new OpenBaoSecretProvider.Config(
            addr,
            "root",
            null,
            null,
            null,
            "secret",
            "keel-test",
            null,
            null,
            Duration.ofMillis(100));
    provider = new OpenBaoSecretProvider(cfg);

    assertEquals(Optional.of(secret), provider.get("api_key"));
    waitUntil(() -> reads.get() >= 2);
    waitUntil(() -> !appender.list.isEmpty());
    provider.close();

    String logged = renderLog(appender);
    assertFalse(logged.contains(secret), "a malformed body must not leak the secret into logs");
    assertFalse(
        logged.contains("Source"),
        "the parser location detail (which can echo the body) must be sanitized away");
    assertFalse(
        logged.contains("StreamReadException"),
        "the raw parser exception must be replaced with a sanitized error");
    assertEquals(
        Optional.of(secret), provider.get("api_key"), "a failed refresh keeps the last good map");
  }

  private static void waitUntil(BooleanSupplier condition) throws InterruptedException {
    long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
    while (System.nanoTime() < deadline) {
      if (condition.getAsBoolean()) {
        return;
      }
      Thread.sleep(25);
    }
    assertFalse(true, "condition not met within 5s");
  }
}
