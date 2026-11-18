package io.keel.core.adapters;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.StackTraceElementProxy;
import ch.qos.logback.core.read.ListAppender;
import com.google.api.gax.retrying.RetrySettings;
import com.google.api.gax.rpc.NotFoundException;
import com.google.api.gax.rpc.StatusCode;
import com.google.cloud.secretmanager.v1.AccessSecretVersionResponse;
import com.google.cloud.secretmanager.v1.SecretManagerServiceClient;
import com.google.cloud.secretmanager.v1.SecretPayload;
import com.google.protobuf.ByteString;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Optional;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * Unit coverage for the GCP Secret Manager adapter (ADR-0024) against a mocked {@link
 * SecretManagerServiceClient} - no network, no metadata-server or ADC lookup. GCP ships no official
 * emulator, so this is the backend's primary test surface (its integration test runs only where
 * real ADC exists); it is correspondingly thorough. Proves the JSON field map round-trips with
 * ADR-0023 coercion, {@code get()} serves from cache, not-found-as-empty, that a non-object /
 * malformed / binary payload fails closed, the no-leak invariant (a refresh failure never writes
 * the secret value or credentials to the log), the bounded-retry settings, and the resolved version
 * resource name.
 */
class GcpSecretManagerSecretProviderTest {

  private static final String SECRET = "projects/keel/secrets/keel-test";

  private GcpSecretManagerSecretProvider provider;
  private Logger capturedLogger;
  private ListAppender<ILoggingEvent> logAppender;

  @AfterEach
  void tearDown() {
    if (provider != null) {
      provider.close();
      provider = null;
    }
    if (capturedLogger != null && logAppender != null) {
      capturedLogger.detachAppender(logAppender);
      capturedLogger = null;
      logAppender = null;
    }
  }

  private static AccessSecretVersionResponse responseOf(String payload) {
    return AccessSecretVersionResponse.newBuilder()
        .setPayload(SecretPayload.newBuilder().setData(ByteString.copyFromUtf8(payload)).build())
        .build();
  }

  private static SecretManagerServiceClient clientReturning(String payload) {
    SecretManagerServiceClient client = mock(SecretManagerServiceClient.class);
    when(client.accessSecretVersion(anyString())).thenReturn(responseOf(payload));
    return client;
  }

  private static NotFoundException notFound() {
    StatusCode notFoundStatus =
        new StatusCode() {
          @Override
          public Code getCode() {
            return Code.NOT_FOUND;
          }

          @Override
          public Object getTransportCode() {
            return null;
          }
        };
    return new NotFoundException(
        new RuntimeException("Secret Manager: secret version not found"), notFoundStatus, false);
  }

  private ListAppender<ILoggingEvent> captureAdapterLog() {
    capturedLogger = (Logger) LoggerFactory.getLogger(GcpSecretManagerSecretProvider.class);
    logAppender = new ListAppender<>();
    logAppender.start();
    capturedLogger.addAppender(logAppender);
    return logAppender;
  }

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

  @Test
  void jsonObjectRoundTripsWithCoercion() {
    SecretManagerServiceClient client =
        clientReturning(
            "{\"api_key\":\"s3cret\",\"n\":7,\"frac\":1.5,\"yes\":true,\"no\":false,"
                + "\"obj\":{\"a\":1},\"arr\":[1,2],\"nul\":null}");
    provider = new GcpSecretManagerSecretProvider(client, SECRET, Duration.ofSeconds(60));

    assertEquals(Optional.of("s3cret"), provider.get("api_key"));
    assertEquals(Optional.of("7"), provider.get("n"), "a number coerces to its JSON text");
    assertEquals(Optional.of("1.5"), provider.get("frac"));
    assertEquals(Optional.of("true"), provider.get("yes"), "a boolean coerces to true/false");
    assertEquals(Optional.of("false"), provider.get("no"));
    assertEquals(Optional.empty(), provider.get("obj"), "an object has no scalar form -> empty");
    assertEquals(Optional.empty(), provider.get("arr"), "an array has no scalar form -> empty");
    assertEquals(Optional.empty(), provider.get("nul"), "a null has no scalar form -> empty");
    assertEquals(Optional.empty(), provider.get("missing"));
  }

  @Test
  void getServesFromCacheWithoutReloading() {
    SecretManagerServiceClient client = clientReturning("{\"api_key\":\"cached\"}");
    provider = new GcpSecretManagerSecretProvider(client, SECRET, Duration.ofSeconds(60));

    assertEquals(Optional.of("cached"), provider.get("api_key"));
    assertEquals(Optional.of("cached"), provider.get("api_key"));
    // One eager AccessSecretVersion at construction, no further I/O on get() (ADR-0024: get() is
    // cached).
    verify(client, times(1)).accessSecretVersion(anyString());
  }

  @Test
  void appendsDefaultLatestVersionToBareSecretName() {
    SecretManagerServiceClient client = clientReturning("{\"api_key\":\"v\"}");
    provider = new GcpSecretManagerSecretProvider(client, SECRET, Duration.ofSeconds(60));
    // A bare projects/.../secrets/<name> resolves to the "latest" version resource name.
    verify(client, times(1)).accessSecretVersion(eq(SECRET + "/versions/latest"));
  }

  @Test
  void usesAnExplicitVersionResourceNameVerbatim() {
    SecretManagerServiceClient client = clientReturning("{\"api_key\":\"v\"}");
    String withVersion = SECRET + "/versions/7";
    provider = new GcpSecretManagerSecretProvider(client, withVersion, Duration.ofSeconds(60));
    // A resource name that already carries /versions/<v> is used as-is, not re-suffixed.
    verify(client, times(1)).accessSecretVersion(eq(withVersion));
  }

  @Test
  void notFoundIsEmptyNotAnError() {
    SecretManagerServiceClient client = mock(SecretManagerServiceClient.class);
    when(client.accessSecretVersion(anyString())).thenThrow(notFound());
    provider = new GcpSecretManagerSecretProvider(client, SECRET, Duration.ofSeconds(60));

    assertEquals(
        Optional.empty(),
        provider.get("api_key"),
        "a NOT_FOUND yields an empty field map, mirroring Vault's 404");
  }

  @Test
  void nonObjectJsonFailsClosed() {
    // A JSON array is valid JSON but not an object of fields: it cannot back get(name).
    SecretManagerServiceClient client = clientReturning("[1,2,3]");
    assertThrows(
        IllegalStateException.class,
        () -> new GcpSecretManagerSecretProvider(client, SECRET, Duration.ofSeconds(60)));
  }

  @Test
  void malformedJsonFailsClosed() {
    SecretManagerServiceClient client = clientReturning("{not valid json");
    assertThrows(
        IllegalStateException.class,
        () -> new GcpSecretManagerSecretProvider(client, SECRET, Duration.ofSeconds(60)));
  }

  @Test
  void binaryPayloadFailsClosed() {
    // A non-UTF-8/binary payload cannot back get(name): decoded to a mojibake string it does not
    // parse as a JSON object, so construction fails closed rather than serving empty.
    SecretManagerServiceClient client = mock(SecretManagerServiceClient.class);
    AccessSecretVersionResponse binary =
        AccessSecretVersionResponse.newBuilder()
            .setPayload(
                SecretPayload.newBuilder()
                    .setData(ByteString.copyFrom(new byte[] {(byte) 0xff, (byte) 0xfe, 0x00, 0x01}))
                    .build())
            .build();
    when(client.accessSecretVersion(anyString())).thenReturn(binary);
    assertThrows(
        IllegalStateException.class,
        () -> new GcpSecretManagerSecretProvider(client, SECRET, Duration.ofSeconds(60)));
  }

  @Test
  void nonPositiveCacheTtlFailsConstruction() {
    SecretManagerServiceClient client = clientReturning("{\"api_key\":\"v\"}");
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () -> new GcpSecretManagerSecretProvider(client, SECRET, Duration.ZERO));
    assertFalse(ex.getMessage().isEmpty(), "a non-positive TTL fails construction");
  }

  @Test
  void requiresSecret() {
    SecretManagerServiceClient client = mock(SecretManagerServiceClient.class);
    assertThrows(
        IllegalStateException.class,
        () -> new GcpSecretManagerSecretProvider(client, "   ", Duration.ofSeconds(60)));
  }

  @Test
  void refreshFailureNeverLogsTheSecretOrCredentials() throws Exception {
    String secret = "top-secret-value-xyz";
    // First load succeeds; the TTL refresh returns a malformed payload that embeds the secret. The
    // sanitized parse error must keep that value (and any credential material) out of the refresh
    // log, and the last good map stays.
    SecretManagerServiceClient client = mock(SecretManagerServiceClient.class);
    when(client.accessSecretVersion(anyString()))
        .thenReturn(responseOf("{\"api_key\":\"" + secret + "\"}"))
        .thenReturn(responseOf("{not json " + secret + "}"));

    ListAppender<ILoggingEvent> appender = captureAdapterLog();
    provider = new GcpSecretManagerSecretProvider(client, SECRET, Duration.ofMillis(100));

    assertEquals(Optional.of(secret), provider.get("api_key"));
    waitUntil(() -> !appender.list.isEmpty());
    provider.close(); // quiesce the scheduler before inspecting the captured log

    String logged = renderLog(appender);
    assertFalse(logged.contains(secret), "the secret value must never appear in any log line");
    assertFalse(
        logged.toLowerCase().contains("credential"),
        "no credential material leaks into the refresh log");
    assertEquals(
        Optional.of(secret), provider.get("api_key"), "a failed refresh keeps the last good map");
  }

  @Test
  void productionClientConfigBoundsTimeoutAndCapsRetries() {
    // ADR-0024's bounded-client rule (the GCP analog of the AWS hard-timeout rule): the production
    // client's accessSecretVersion settings must fail a wedged/unreachable Secret Manager - or a
    // degraded ADC/metadata lookup - fast (bounded total + per-RPC timeout) and cap the attempt
    // budget so a blackholed endpoint cannot stall startup under the SDK's generous default
    // retries.
    RetrySettings retry = GcpSecretManagerSecretProvider.boundedRetrySettings();

    assertEquals(
        Duration.ofSeconds(15),
        retry.getTotalTimeoutDuration(),
        "the whole accessSecretVersion call is bounded at 15s");
    assertEquals(2, retry.getMaxAttempts(), "the attempt budget is capped at 2 (one retry)");
    assertEquals(
        Duration.ofSeconds(10),
        retry.getInitialRpcTimeoutDuration(),
        "each RPC attempt starts bounded at 10s");
    assertEquals(
        Duration.ofSeconds(10),
        retry.getMaxRpcTimeoutDuration(),
        "each RPC attempt is bounded at 10s");
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
