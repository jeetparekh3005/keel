package io.keel.core.adapters.outbound.rpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.grpc.ChannelCredentials;
import io.grpc.Grpc;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.ServerCredentials;
import io.grpc.ServerInterceptor;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.MetadataUtils;
import io.keel.core.adapters.inbound.rpc.GrpcAuthInterceptor;
import io.keel.core.adapters.inbound.rpc.GrpcServerFactory;
import io.keel.core.adapters.inbound.rpc.InMemoryItemService;
import io.keel.core.auth.ScopeAuthoritiesConverter;
import io.keel.reference.v1.CreateItemRequest;
import io.keel.reference.v1.CreateItemResponse;
import io.keel.reference.v1.ItemServiceGrpc;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.instrumentation.grpc.v1_6.GrpcTelemetry;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/**
 * mTLS over a real loopback (netty on an ephemeral port): the server requires a client certificate
 * chaining to the shared CA. A trusted client (CA-signed cert) completes the handshake and the
 * authenticated call returns a payload; an untrusted client (a cert under a different CA) is
 * rejected at the TLS layer, so it never reaches the servicer. The PKI is generated in-process by
 * {@link TestPki}; no key material is committed.
 */
class MtlsCredentialsTest {

  private static final String WRITE_TOKEN = "mtls-write";

  private Server server;
  private int port;
  private TestPki pki;

  // Minimal stub decoder: one opaque token -> a minted Jwt with items:write.
  private static JwtDecoder stubDecoder() {
    Jwt jwt =
        Jwt.withTokenValue("minted")
            .header("alg", "none")
            .subject("svc-mtls")
            .claim("scope", "items:read items:write")
            .issuedAt(Instant.now())
            .expiresAt(Instant.now().plus(5, ChronoUnit.MINUTES))
            .build();
    return token -> {
      if (WRITE_TOKEN.equals(token)) {
        return jwt;
      }
      throw new BadJwtException("unknown test token");
    };
  }

  @BeforeEach
  void startMtlsServer() throws Exception {
    pki = TestPki.generate();
    ServerCredentials serverCreds =
        MtlsCredentials.serverCredentials(pki.server.cert(), pki.server.key(), pki.caCertPem);
    assertThat(serverCreds).isNotNull();

    GrpcAuthInterceptor auth =
        new GrpcAuthInterceptor(
            stubDecoder(),
            new ScopeAuthoritiesConverter(),
            Map.of(
                ItemServiceGrpc.getCreateItemMethod().getFullMethodName(), Set.of("items:write")),
            Set.of());
    ServerInterceptor tracing =
        GrpcTelemetry.create(OpenTelemetry.noop()).createServerInterceptor();
    server =
        GrpcServerFactory.create(0, serverCreds, auth, tracing, List.of(new InMemoryItemService()));
    server.start();
    port = server.getPort();
    assertThat(port).isGreaterThan(0);
  }

  @AfterEach
  void stopServer() throws Exception {
    server.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
  }

  private CreateItemResponse create(ChannelCredentials creds, String token) {
    ManagedChannel channel = Grpc.newChannelBuilderForAddress("localhost", port, creds).build();
    try {
      io.grpc.Metadata md = new io.grpc.Metadata();
      md.put(
          io.grpc.Metadata.Key.of("authorization", io.grpc.Metadata.ASCII_STRING_MARSHALLER),
          "Bearer " + token);
      return ItemServiceGrpc.newBlockingStub(channel)
          .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(md))
          .withDeadlineAfter(10, TimeUnit.SECONDS)
          .createItem(CreateItemRequest.newBuilder().setName("secured").build());
    } finally {
      channel.shutdownNow();
    }
  }

  @Test
  void trustedClientCompletesHandshakeAndCallSucceeds() throws Exception {
    ChannelCredentials clientCreds =
        MtlsCredentials.channelCredentials(pki.client.cert(), pki.client.key(), pki.caCertPem);
    assertThat(clientCreds).isNotNull();

    CreateItemResponse response = create(clientCreds, WRITE_TOKEN);
    assertThat(response.getItem().getName()).isEqualTo("secured");
    assertThat(response.getItem().getId()).isNotBlank();
  }

  @Test
  void untrustedClientIsRejectedAtTlsLayer() throws Exception {
    // A cert signed by a different CA: it does not chain to the server's trust anchor, so the
    // server aborts the handshake and the call never reaches the servicer.
    ChannelCredentials untrusted =
        MtlsCredentials.channelCredentials(
            pki.untrustedClient.cert(), pki.untrustedClient.key(), pki.caCertPem);
    assertThatThrownBy(() -> create(untrusted, WRITE_TOKEN))
        .isInstanceOf(StatusRuntimeException.class);
  }
}
