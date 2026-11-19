package io.keel.core;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.keel.core.adapters.EnvSecretProvider;
import io.keel.core.config.KeelProperties;
import io.keel.core.ports.SecretProvider;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Covers the {@link SecretProvider} selection factory (ADR-0023, ADR-0024). None set -> {@link
 * EnvSecretProvider}; a bound-but-blank gating var is treated as unset (so an empty {@code
 * KEEL_VAULT_ADDR} does not activate OpenBao and crash startup); exactly one selects that backend,
 * which then fails loudly on misconfiguration (fail-closed); more than one (among Vault, AWS, and
 * GCP) is an ambiguous misconfiguration that fails construction.
 */
class KeelCoreAutoConfigurationTest {

  private final KeelCoreAutoConfiguration autoConfig = new KeelCoreAutoConfiguration();

  @Test
  void noBackendConfiguredYieldsEnvSecretProvider() {
    SecretProvider provider = autoConfig.secretProvider(props("", null, "", "", ""));
    assertInstanceOf(
        EnvSecretProvider.class,
        provider,
        "no secret backend configured selects the dev EnvSecretProvider");
  }

  @Test
  void blankVaultAddrYieldsEnvSecretProvider() {
    SecretProvider provider = autoConfig.secretProvider(props("", null, "", "", ""));
    assertInstanceOf(
        EnvSecretProvider.class,
        provider,
        "an empty KEEL_VAULT_ADDR is treated as unset and must not crash startup");
  }

  @Test
  void whitespaceGatingVarsYieldEnvSecretProvider() {
    SecretProvider provider = autoConfig.secretProvider(props("   ", null, "", "   ", "   "));
    assertInstanceOf(
        EnvSecretProvider.class, provider, "a whitespace-only gating var is treated as unset");
  }

  @Test
  void nonBlankVaultAddrSelectsOpenBaoAndFailsClosedWhenUnreachable() {
    // A real address selects the OpenBao provider, which fails loudly (fail-closed) when the server
    // is unreachable rather than silently falling through to the environment.
    assertThrows(
        RuntimeException.class,
        () -> autoConfig.secretProvider(props("http://127.0.0.1:1", "root", "keel-test", "", "")));
  }

  @Test
  void bothVaultAndAwsSetFailsConstruction() {
    // At most one backend may be configured (ADR-0024); more than one is an ambiguous
    // misconfiguration that must fail construction rather than silently preferring one.
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () ->
                autoConfig.secretProvider(
                    props("http://127.0.0.1:1", "root", "keel-test", "keel-test", "")));
    assertTrue(
        ex.getMessage().contains("multiple secret backends configured"),
        "both backends set fails loudly with an ambiguous-misconfiguration message");
  }

  @Test
  void bothVaultAndGcpSetFailsConstruction() {
    // The GCP gating var (KEEL_GCP_SECRET) joins the at-most-one rule: Vault + GCP is ambiguous and
    // fails construction before any backend (or GCP client) is built, so this stays hermetic.
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () ->
                autoConfig.secretProvider(
                    props(
                        "http://127.0.0.1:1",
                        "root",
                        "keel-test",
                        "",
                        "projects/p/secrets/keel-test")));
    assertTrue(
        ex.getMessage().contains("multiple secret backends configured")
            && ex.getMessage().contains("KEEL_GCP_SECRET"),
        "Vault + GCP fails loudly and the message names the GCP gating var");
  }

  @Test
  void bothAwsAndGcpSetFailsConstruction() {
    // AWS + GCP is equally ambiguous and fails at the count check before constructing either
    // client,
    // so no network/ADC lookup happens.
    IllegalStateException ex =
        assertThrows(
            IllegalStateException.class,
            () ->
                autoConfig.secretProvider(
                    props("", null, "", "keel-test", "projects/p/secrets/keel-test")));
    assertTrue(
        ex.getMessage().contains("multiple secret backends configured"),
        "AWS + GCP fails loudly with an ambiguous-misconfiguration message");
  }

  private static KeelProperties props(
      String vaultAddr, String vaultToken, String vaultPath, String awsSecretId, String gcpSecret) {
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
        "",
        "keel",
        "keel",
        "keel.dlx",
        List.of("keel.#"),
        List.of(),
        List.of("keel"),
        "keel",
        "",
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
        60,
        awsSecretId,
        "",
        gcpSecret,
        "latest");
  }
}
