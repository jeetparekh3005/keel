package io.keel.core;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.keel.core.adapters.EnvSecretProvider;
import io.keel.core.config.KeelProperties;
import io.keel.core.ports.SecretProvider;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Covers the {@link SecretProvider} selection factory (ADR-0023). A bound-but-blank {@code
 * KEEL_VAULT_ADDR} must fall back to {@link EnvSecretProvider} rather than activating OpenBao and
 * crashing startup (the empty-string gating divergence); only a non-blank address selects the
 * production provider, which then fails loudly on misconfiguration (fail-closed).
 */
class KeelCoreAutoConfigurationTest {

  private final KeelCoreAutoConfiguration autoConfig = new KeelCoreAutoConfiguration();

  @Test
  void blankVaultAddrYieldsEnvSecretProvider() {
    SecretProvider provider = autoConfig.secretProvider(props("", null, ""));
    assertInstanceOf(
        EnvSecretProvider.class,
        provider,
        "an empty KEEL_VAULT_ADDR is treated as unset and must not crash startup");
  }

  @Test
  void whitespaceVaultAddrYieldsEnvSecretProvider() {
    SecretProvider provider = autoConfig.secretProvider(props("   ", null, ""));
    assertInstanceOf(
        EnvSecretProvider.class, provider, "a whitespace-only KEEL_VAULT_ADDR is treated as unset");
  }

  @Test
  void nonBlankVaultAddrSelectsOpenBaoAndFailsClosedWhenUnreachable() {
    // A real address selects the OpenBao provider, which fails loudly (fail-closed) when the server
    // is unreachable rather than silently falling through to the environment.
    assertThrows(
        RuntimeException.class,
        () -> autoConfig.secretProvider(props("http://127.0.0.1:1", "root", "keel-test")));
  }

  private static KeelProperties props(String vaultAddr, String vaultToken, String vaultPath) {
    return new KeelProperties(
        "",
        "",
        "",
        "postgres://localhost/keel",
        1_048_576L,
        List.of(),
        List.of(),
        "",
        "keel",
        List.of("keel.>"),
        0,
        "",
        "",
        "",
        false,
        vaultAddr,
        vaultToken,
        "",
        "kubernetes",
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "secret",
        vaultPath,
        "",
        "",
        60);
  }
}
