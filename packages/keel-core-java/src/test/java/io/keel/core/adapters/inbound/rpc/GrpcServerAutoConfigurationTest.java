package io.keel.core.adapters.inbound.rpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.grpc.Server;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import io.keel.core.ports.SecretProvider;
import io.keel.reference.v1.CreateItemRequest;
import io.keel.reference.v1.CreateItemResponse;
import io.keel.reference.v1.ItemServiceGrpc;
import io.opentelemetry.api.OpenTelemetry;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/**
 * Verifies the gRPC auto-config is gated on {@code keel.grpc-port}: absent, nothing is wired; set,
 * the server binds and the lifecycle runs. Covers both transport branches - plaintext (no TLS) and
 * mTLS (PEM supplied via a {@link SecretProvider}) - so enabling the port is all a service does.
 */
class GrpcServerAutoConfigurationTest {

  private final ApplicationContextRunner runner =
      new ApplicationContextRunner()
          .withConfiguration(AutoConfigurations.of(GrpcServerAutoConfiguration.class))
          .withUserConfiguration(StubBeans.class);

  @Test
  void notWiredWithoutPort() {
    runner.run(context -> {
      assertThat(context).hasNotFailed();
      assertThat(context).doesNotHaveBean(Server.class);
      assertThat(context).doesNotHaveBean(GrpcServerLifecycle.class);
    });
  }

  @Test
  void bindsPlaintextServerWhenPortConfiguredAndInsecureOptIn() {
    // Plaintext requires the explicit opt-in; without TLS material the server would otherwise
    // fail-closed (see failsStartupWhenTlsIncompleteAndNoInsecureOptIn).
    runner
        .withPropertyValues("keel.grpc-port=0", "keel.grpc-tls-insecure=true")
        .withBean(SecretProvider.class, () -> (SecretProvider) (key -> Optional.empty()))
        .run(context -> {
          assertThat(context).hasSingleBean(GrpcServerLifecycle.class);
          assertThat(context).hasSingleBean(InMemoryItemService.class);
          GrpcServerLifecycle lifecycle = context.getBean(GrpcServerLifecycle.class);
          assertThat(lifecycle.isRunning()).isTrue();
          assertThat(lifecycle.port()).isGreaterThan(0);
        });
  }

  @Test
  void failsStartupWhenTlsIncompleteAndNoInsecureOptIn() {
    // Fail-closed: an exposed port with no TLS material and no plaintext opt-in must refuse to
    // start rather than silently serving cleartext.
    runner
        .withPropertyValues("keel.grpc-port=0")
        .withBean(SecretProvider.class, () -> (SecretProvider) (key -> Optional.empty()))
        .run(context -> {
          assertThat(context).hasFailed();
          assertThat(context.getStartupFailure())
              .rootCause()
              .isInstanceOf(IllegalStateException.class)
              .hasMessageContaining("refusing to serve plaintext");
        });
  }

  @Test
  void autoConfiguredInterceptorDeniesWrongScope() {
    // Drive a real negative call through the AUTO-CONFIGURED interceptor bean and its canonical
    // scope map (not a restated copy): a read-scoped caller invoking CreateItem (needs items:write)
    // is closed PERMISSION_DENIED. This is what catches the bean's policy drifting from the
    // contract.
    runner
        .withPropertyValues("keel.grpc-port=0", "keel.grpc-tls-insecure=true")
        .withBean(SecretProvider.class, () -> (SecretProvider) (key -> Optional.empty()))
        .run(context -> {
          assertThat(context).hasSingleBean(GrpcAuthInterceptor.class);
          GrpcAuthInterceptor interceptor = context.getBean(GrpcAuthInterceptor.class);

          @SuppressWarnings("unchecked")
          ServerCall<CreateItemRequest, CreateItemResponse> call = mock(ServerCall.class);
          when(call.getMethodDescriptor()).thenReturn(ItemServiceGrpc.getCreateItemMethod());
          @SuppressWarnings("unchecked")
          ServerCallHandler<CreateItemRequest, CreateItemResponse> next =
              mock(ServerCallHandler.class);

          interceptor.interceptCall(call, GrpcTestSupport.bearer(GrpcTestSupport.READ_TOKEN), next);

          ArgumentCaptor<Status> status = ArgumentCaptor.forClass(Status.class);
          verify(call).close(status.capture(), any());
          assertThat(status.getValue().getCode()).isEqualTo(Status.Code.PERMISSION_DENIED);
          verify(next, never()).startCall(any(), any());
        });
  }

  @Test
  void bindsMtlsServerWhenTlsMaterialPresent() {
    runner
        .withPropertyValues("keel.grpc-port=0")
        .withBean(SecretProvider.class, GrpcServerAutoConfigurationTest::tlsSecretProvider)
        .run(context -> {
          assertThat(context).hasSingleBean(GrpcServerLifecycle.class);
          GrpcServerLifecycle lifecycle = context.getBean(GrpcServerLifecycle.class);
          assertThat(lifecycle.isRunning()).isTrue();
          assertThat(lifecycle.port()).isGreaterThan(0);
        });
  }

  private static SecretProvider tlsSecretProvider() {
    io.keel.core.adapters.outbound.rpc.TestPki pki =
        io.keel.core.adapters.outbound.rpc.TestPki.generate();
    Map<String, String> pem =
        Map.of(
            GrpcServerAutoConfiguration.CERT_KEY, pki.server.certString(),
            GrpcServerAutoConfiguration.KEY_KEY, pki.server.keyString(),
            GrpcServerAutoConfiguration.CA_KEY,
                new String(pki.caCertPem, java.nio.charset.StandardCharsets.UTF_8));
    return key -> Optional.ofNullable(pem.get(key));
  }

  /**
   * The collaborators the auto-config needs: the JWT decoder, OpenTelemetry, and a SecretProvider.
   */
  @Configuration(proxyBeanMethods = false)
  static class StubBeans {

    @Bean
    JwtDecoder jwtDecoder() {
      return GrpcTestSupport.stubDecoder();
    }

    @Bean
    OpenTelemetry openTelemetry() {
      return OpenTelemetry.noop();
    }
  }
}
