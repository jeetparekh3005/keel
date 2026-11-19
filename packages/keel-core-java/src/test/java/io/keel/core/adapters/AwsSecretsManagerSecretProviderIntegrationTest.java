package io.keel.core.adapters;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Duration;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient;
import software.amazon.awssdk.services.secretsmanager.model.CreateSecretRequest;
import software.amazon.awssdk.services.secretsmanager.model.PutSecretValueRequest;
import software.amazon.awssdk.services.secretsmanager.model.ResourceExistsException;

/**
 * Verifies the AWS Secrets Manager adapter end to end against a real Secrets Manager API
 * (ADR-0024).
 *
 * <p>Runs only when {@code KEEL_AWS_SECRET_ID} is set; CI starts a LocalStack Secrets Manager
 * container (see {@code .github/workflows/java.yml}) and the test is skipped otherwise, exactly
 * like the OpenBao/NATS/Keycloak integration tests. The v2 client routes to LocalStack via the
 * standard {@code AWS_ENDPOINT_URL_SECRETS_MANAGER} env var. The test writes a JSON secret with the
 * raw SDK, then reads a field back through the adapter, proving the GetSecretValue + JSON-field-map
 * path against a live endpoint.
 */
class AwsSecretsManagerSecretProviderIntegrationTest {

  @Test
  @EnabledIfEnvironmentVariable(named = "KEEL_AWS_SECRET_ID", matches = ".+")
  void writesThenReadsAJsonSecretThroughTheAdapter() {
    String secretId = System.getenv("KEEL_AWS_SECRET_ID");
    String region = envOrDefault("AWS_REGION", "us-east-1");
    String expected = "value-" + UUID.randomUUID();
    String payload = "{\"api_key\":\"" + expected + "\"}";

    // The SDK honors AWS_ENDPOINT_URL_SECRETS_MANAGER (LocalStack) and the default credential chain
    // (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY). url-connection-client matches the adapter's HTTP
    // client (apache-client is excluded from the dependency).
    try (SecretsManagerClient admin =
        SecretsManagerClient.builder()
            .httpClientBuilder(UrlConnectionHttpClient.builder())
            .region(Region.of(region))
            .build()) {
      try {
        admin.createSecret(
            CreateSecretRequest.builder().name(secretId).secretString(payload).build());
      } catch (ResourceExistsException alreadyExists) {
        admin.putSecretValue(
            PutSecretValueRequest.builder().secretId(secretId).secretString(payload).build());
      }
    }

    // The empty region selects the SDK's own region resolution (AWS_REGION), exercising the real
    // client-building path.
    try (AwsSecretsManagerSecretProvider provider =
        new AwsSecretsManagerSecretProvider(
            new AwsSecretsManagerSecretProvider.Config(secretId, "", Duration.ofSeconds(60)))) {
      assertEquals(Optional.of(expected), provider.get("api_key"));
    }
  }

  private static String envOrDefault(String name, String fallback) {
    String value = System.getenv(name);
    return (value == null || value.isEmpty()) ? fallback : value;
  }
}
