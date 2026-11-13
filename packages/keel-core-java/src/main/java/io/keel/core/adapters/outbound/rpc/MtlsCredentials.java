package io.keel.core.adapters.outbound.rpc;

import io.grpc.ChannelCredentials;
import io.grpc.ServerCredentials;
import io.grpc.TlsChannelCredentials;
import io.grpc.TlsServerCredentials;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Builds gRPC mTLS credentials from PEM material (ADR-0022; PKI from OpenBao, ADR-0007). The server
 * serves its leaf cert/key and <strong>requires</strong> a client certificate chaining to the
 * trusted CA; the client presents its own leaf cert/key and verifies the server against the same
 * CA. Service-to-service calls are therefore mutually authenticated, the Java analog of the Python
 * vertical's {@code mtls_server_credentials}/{@code mtls_channel_credentials}.
 *
 * <p>The PEM bytes come from configuration or a {@link io.keel.core.ports.SecretProvider}; this
 * type only turns them into credentials, so the secret source stays a separate concern.
 */
public final class MtlsCredentials {

  private MtlsCredentials() {}

  /**
   * Server-side mTLS: serve {@code certChainPem}/{@code privateKeyPem} and require a client
   * certificate that chains to {@code trustedCaPem}. {@link
   * TlsServerCredentials.ClientAuth#REQUIRE} is what makes an anonymous or untrusted client fail
   * the handshake rather than connect.
   *
   * @throws IOException if the PEM material cannot be parsed
   */
  public static ServerCredentials serverCredentials(
      byte[] certChainPem, byte[] privateKeyPem, byte[] trustedCaPem) throws IOException {
    return TlsServerCredentials.newBuilder()
        .keyManager(new ByteArrayInputStream(certChainPem), new ByteArrayInputStream(privateKeyPem))
        .trustManager(new ByteArrayInputStream(trustedCaPem))
        .clientAuth(TlsServerCredentials.ClientAuth.REQUIRE)
        .build();
  }

  /**
   * Client-side mTLS: present {@code certChainPem}/{@code privateKeyPem} and verify the server
   * against {@code trustedCaPem}.
   *
   * @throws IOException if the PEM material cannot be parsed
   */
  public static ChannelCredentials channelCredentials(
      byte[] certChainPem, byte[] privateKeyPem, byte[] trustedCaPem) throws IOException {
    return TlsChannelCredentials.newBuilder()
        .keyManager(new ByteArrayInputStream(certChainPem), new ByteArrayInputStream(privateKeyPem))
        .trustManager(new ByteArrayInputStream(trustedCaPem))
        .build();
  }

  /** Convenience overload for PEM held as strings (config/secret values). */
  public static ServerCredentials serverCredentials(
      String certChainPem, String privateKeyPem, String trustedCaPem) throws IOException {
    return serverCredentials(utf8(certChainPem), utf8(privateKeyPem), utf8(trustedCaPem));
  }

  /** Convenience overload for PEM held as strings (config/secret values). */
  public static ChannelCredentials channelCredentials(
      String certChainPem, String privateKeyPem, String trustedCaPem) throws IOException {
    return channelCredentials(utf8(certChainPem), utf8(privateKeyPem), utf8(trustedCaPem));
  }

  private static byte[] utf8(String pem) {
    return pem.getBytes(StandardCharsets.UTF_8);
  }
}
