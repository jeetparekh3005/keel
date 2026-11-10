package io.keel.core.ports;

import java.util.Optional;

/** Resolves a secret by key (highest-precedence config source); empty when absent. */
public interface SecretProvider {
  Optional<String> get(String key);
}
