package io.keel.core.adapters;

import io.keel.core.ports.SecretProvider;
import java.util.Optional;

/**
 * Reads secrets from environment variables (the dev adapter; production uses a real secret manager,
 * ADR-0007).
 */
public final class EnvSecretProvider implements SecretProvider {
  @Override
  public Optional<String> get(String key) {
    String value = System.getenv(key);
    return (value == null || value.isEmpty()) ? Optional.empty() : Optional.of(value);
  }
}
