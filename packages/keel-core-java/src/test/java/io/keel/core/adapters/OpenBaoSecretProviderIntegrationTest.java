package io.keel.core.adapters;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Verifies the OpenBao adapter end to end against a real {@code openbao:2.7.2} dev server
 * (ADR-0023).
 *
 * <p>Runs only when {@code KEEL_VAULT_ADDR} is set; CI starts an OpenBao dev container (see {@code
 * .github/workflows/java.yml}) and the test is skipped otherwise, exactly like the NATS/Keycloak
 * integration tests. It writes a KV v2 secret with the raw HTTP API, then reads the same field back
 * through the adapter, proving the authenticate + KV v2 read path against a live server.
 */
class OpenBaoSecretProviderIntegrationTest {

  @Test
  @EnabledIfEnvironmentVariable(named = "KEEL_VAULT_ADDR", matches = ".+")
  void writesThenReadsAKvV2SecretThroughTheAdapter() throws Exception {
    String addr = System.getenv("KEEL_VAULT_ADDR");
    String token = envOrDefault("KEEL_VAULT_TOKEN", "root");
    String mount = envOrDefault("KEEL_VAULT_MOUNT", "secret");
    String path = envOrDefault("KEEL_VAULT_PATH", "keel-test");
    String expected = "value-" + UUID.randomUUID();

    HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    HttpRequest write =
        HttpRequest.newBuilder(URI.create(addr + "/v1/" + mount + "/data/" + path))
            .timeout(Duration.ofSeconds(10))
            .header("X-Vault-Token", token)
            .header("Content-Type", "application/json")
            .POST(
                BodyPublishers.ofString(
                    "{\"data\":{\"api_key\":\"" + expected + "\"}}", StandardCharsets.UTF_8))
            .build();
    int status = http.send(write, BodyHandlers.ofString()).statusCode();
    assertEquals(2, status / 100, "writing the KV v2 secret should succeed, got HTTP " + status);

    OpenBaoSecretProvider.Config config =
        new OpenBaoSecretProvider.Config(
            addr, token, null, null, null, mount, path, null, null, Duration.ofSeconds(60));
    try (OpenBaoSecretProvider provider = new OpenBaoSecretProvider(config)) {
      assertEquals(Optional.of(expected), provider.get("api_key"));
    }
  }

  private static String envOrDefault(String name, String fallback) {
    String value = System.getenv(name);
    return (value == null || value.isEmpty()) ? fallback : value;
  }
}
