package io.keel.core.adapters;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.StackTraceElementProxy;
import ch.qos.logback.core.read.ListAppender;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Optional;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.core.SdkBytes;
import software.amazon.awssdk.core.client.config.ClientOverrideConfiguration;
import software.amazon.awssdk.retries.DefaultRetryStrategy;
import software.amazon.awssdk.retries.api.RetryStrategy;
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient;
import software.amazon.awssdk.services.secretsmanager.model.GetSecretValueRequest;
import software.amazon.awssdk.services.secretsmanager.model.GetSecretValueResponse;
import software.amazon.awssdk.services.secretsmanager.model.ResourceNotFoundException;

/**
 * Unit coverage for the AWS Secrets Manager adapter (ADR-0024) against a mocked {@link
 * SecretsManagerClient} - the v2 client is an interface, so no network. Proves the JSON field map
 * round-trips with ADR-0023 coercion, not-found-as-empty, that a binary-only / non-object /
 * malformed payload fails closed, and the no-leak invariant (a refresh failure never writes the
 * secret value to the log).
 */
class AwsSecretsManagerSecretProviderTest {

  private AwsSecretsManagerSecretProvider provider;
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

  private static SecretsManagerClient clientReturning(String secretString) {
    SecretsManagerClient client = mock(SecretsManagerClient.class);
    when(client.getSecretValue(any(GetSecretValueRequest.class)))
        .thenReturn(GetSecretValueResponse.builder().secretString(secretString).build());
    return client;
  }

  private ListAppender<ILoggingEvent> captureAdapterLog() {
    capturedLogger = (Logger) LoggerFactory.getLogger(AwsSecretsManagerSecretProvider.class);
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
    SecretsManagerClient client =
        clientReturning(
            "{\"api_key\":\"s3cret\",\"n\":7,\"frac\":1.5,\"yes\":true,\"no\":false,"
                + "\"obj\":{\"a\":1},\"arr\":[1,2],\"nul\":null}");
    provider = new AwsSecretsManagerSecretProvider(client, "keel-test", Duration.ofSeconds(60));

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
    SecretsManagerClient client = clientReturning("{\"api_key\":\"cached\"}");
    provider = new AwsSecretsManagerSecretProvider(client, "keel-test", Duration.ofSeconds(60));

    assertEquals(Optional.of("cached"), provider.get("api_key"));
    assertEquals(Optional.of("cached"), provider.get("api_key"));
    // One eager GetSecretValue at construction, no further I/O on get() (ADR-0024: get() is
    // cached).
    org.mockito.Mockito.verify(client, org.mockito.Mockito.times(1))
        .getSecretValue(any(GetSecretValueRequest.class));
  }

  @Test
  void resourceNotFoundIsEmptyNotAnError() {
    SecretsManagerClient client = mock(SecretsManagerClient.class);
    when(client.getSecretValue(any(GetSecretValueRequest.class)))
        .thenThrow(
            ResourceNotFoundException.builder().message("Secrets Manager can't find it").build());
    provider = new AwsSecretsManagerSecretProvider(client, "keel-test", Duration.ofSeconds(60));

    assertEquals(
        Optional.empty(),
        provider.get("api_key"),
        "ResourceNotFoundException yields an empty field map, mirroring Vault's 404");
  }

  @Test
  void binaryOnlySecretFailsClosed() {
    SecretsManagerClient client = mock(SecretsManagerClient.class);
    when(client.getSecretValue(any(GetSecretValueRequest.class)))
        .thenReturn(
            GetSecretValueResponse.builder()
                .secretBinary(SdkBytes.fromByteArray(new byte[] {1, 2, 3}))
                .build());
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () -> new AwsSecretsManagerSecretProvider(client, "keel-test", Duration.ofSeconds(60)));
    assertFalse(
        ex.getMessage().isEmpty(), "a binary-only secret fails construction rather than empty get");
  }

  @Test
  void nonObjectJsonFailsClosed() {
    // A JSON array is valid JSON but not an object of fields: it cannot back get(name).
    SecretsManagerClient client = clientReturning("[1,2,3]");
    assertThrows(
        IllegalStateException.class,
        () -> new AwsSecretsManagerSecretProvider(client, "keel-test", Duration.ofSeconds(60)));
  }

  @Test
  void malformedJsonFailsClosed() {
    SecretsManagerClient client = clientReturning("{not valid json");
    assertThrows(
        IllegalStateException.class,
        () -> new AwsSecretsManagerSecretProvider(client, "keel-test", Duration.ofSeconds(60)));
  }

  @Test
  void nonPositiveCacheTtlFailsConstruction() {
    SecretsManagerClient client = clientReturning("{\"api_key\":\"v\"}");
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () -> new AwsSecretsManagerSecretProvider(client, "keel-test", Duration.ZERO));
    assertFalse(ex.getMessage().isEmpty(), "a non-positive TTL fails construction");
  }

  @Test
  void refreshFailureNeverLogsTheSecret() throws Exception {
    String secret = "top-secret-value-xyz";
    // First load succeeds; the TTL refresh returns a malformed payload that embeds the secret. The
    // sanitized parse error must keep that value out of the refresh log, and the last good map
    // stays.
    SecretsManagerClient client = mock(SecretsManagerClient.class);
    when(client.getSecretValue(any(GetSecretValueRequest.class)))
        .thenReturn(
            GetSecretValueResponse.builder()
                .secretString("{\"api_key\":\"" + secret + "\"}")
                .build())
        .thenReturn(
            GetSecretValueResponse.builder().secretString("{not json " + secret + "}").build());

    ListAppender<ILoggingEvent> appender = captureAdapterLog();
    provider = new AwsSecretsManagerSecretProvider(client, "keel-test", Duration.ofMillis(100));

    assertEquals(Optional.of(secret), provider.get("api_key"));
    waitUntil(() -> !appender.list.isEmpty());
    provider.close(); // quiesce the scheduler before inspecting the captured log

    String logged = renderLog(appender);
    assertFalse(logged.contains(secret), "the secret value must never appear in any log line");
    assertEquals(
        Optional.of(secret), provider.get("api_key"), "a failed refresh keeps the last good map");
  }

  @Test
  void productionClientConfigBoundsTimeoutAndCapsRetries() {
    // ADR-0023's hard-HTTP-timeout rule: the production client's override must fail a wedged
    // GetSecretValue fast (bounded call + per-attempt timeout) and cap the retry budget so a
    // blackholed endpoint cannot multiply the per-attempt stall across many retries at startup.
    ClientOverrideConfiguration config = AwsSecretsManagerSecretProvider.hardTimeoutConfiguration();

    assertEquals(
        Optional.of(Duration.ofSeconds(15)),
        config.apiCallTimeout(),
        "the whole GetSecretValue call is bounded at 15s");
    assertEquals(
        Optional.of(Duration.ofSeconds(10)),
        config.apiCallAttemptTimeout(),
        "each attempt is bounded at 10s");
    // The configurator form mutates the SDK's resolved default strategy at client-build time, so
    // apply it to a standard strategy builder here and confirm it caps the attempt budget.
    assertTrue(
        config.retryStrategyConfigurator().isPresent(), "a bounded retry strategy is configured");
    var retryBuilder = DefaultRetryStrategy.standardStrategyBuilder();
    config.retryStrategyConfigurator().orElseThrow().accept(retryBuilder);
    RetryStrategy retryStrategy = retryBuilder.build();
    assertEquals(
        2, retryStrategy.maxAttempts(), "the retry budget is capped at 2 attempts (1 retry)");
  }

  @Test
  void requiresSecretId() {
    SecretsManagerClient client = mock(SecretsManagerClient.class);
    assertThrows(
        IllegalStateException.class,
        () -> new AwsSecretsManagerSecretProvider(client, "   ", Duration.ofSeconds(60)));
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
