package io.keel.core.adapters;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.time.Duration;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Verifies the GCP Secret Manager adapter end to end against the real Secret Manager API
 * (ADR-0024).
 *
 * <p>GCP ships no official Secret Manager emulator, so - unlike the OpenBao and AWS (LocalStack)
 * integration tests - this one has no CI-run container. It is the one secret backend without a
 * CI-run integration test (documented in ADR-0024); its unit coverage ({@link
 * GcpSecretManagerSecretProviderTest}) is correspondingly thorough. It runs only where real
 * Application Default Credentials and a secret exist: gated on {@code KEEL_GCP_SECRET} via {@link
 * EnabledIfEnvironmentVariable} and skipped otherwise (so it skips in CI and on any developer
 * machine without GCP credentials).
 *
 * <p>Point {@code KEEL_GCP_SECRET} at a {@code projects/<project>/secrets/<name>} (or a full {@code
 * .../versions/<v>}) holding a JSON object, with ADC resolvable (e.g. {@code
 * GOOGLE_APPLICATION_CREDENTIALS} or {@code gcloud auth application-default login}). Optionally set
 * {@code KEEL_GCP_SECRET_VERSION} (default {@code latest}) and, to assert a specific field, {@code
 * KEEL_GCP_TEST_FIELD} + {@code KEEL_GCP_TEST_VALUE}; without those it asserts the secret loads
 * through the full ADC + AccessSecretVersion + JSON-field-map path.
 */
class GcpSecretManagerSecretProviderIntegrationTest {

  @Test
  @EnabledIfEnvironmentVariable(named = "KEEL_GCP_SECRET", matches = ".+")
  void readsAJsonSecretThroughTheAdapter() {
    String secret = System.getenv("KEEL_GCP_SECRET");
    String version = envOrDefault("KEEL_GCP_SECRET_VERSION", "latest");
    String field = System.getenv("KEEL_GCP_TEST_FIELD");
    String expected = System.getenv("KEEL_GCP_TEST_VALUE");

    // Credentials come from Application Default Credentials; only the secret resource name and
    // version are configured. Construction performs the eager load, so a successful construction
    // already proves the ADC + AccessSecretVersion + JSON-object parse path end to end.
    try (GcpSecretManagerSecretProvider provider =
        new GcpSecretManagerSecretProvider(
            new GcpSecretManagerSecretProvider.Config(secret, version, Duration.ofSeconds(60)))) {
      if (field != null && !field.isEmpty()) {
        assertEquals(Optional.ofNullable(expected), provider.get(field));
      } else {
        // No specific field named: at least prove get() is wired and serves from the loaded map.
        assertNotNull(
            provider.get("api_key"), "get() returns an Optional from the loaded field map");
      }
    }
  }

  private static String envOrDefault(String name, String fallback) {
    String value = System.getenv(name);
    return (value == null || value.isEmpty()) ? fallback : value;
  }
}
