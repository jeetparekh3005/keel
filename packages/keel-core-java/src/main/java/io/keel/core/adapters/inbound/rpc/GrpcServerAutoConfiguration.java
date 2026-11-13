package io.keel.core.adapters.inbound.rpc;

import io.grpc.BindableService;
import io.grpc.InsecureServerCredentials;
import io.grpc.Server;
import io.grpc.ServerCredentials;
import io.grpc.ServerInterceptor;
import io.keel.core.adapters.outbound.rpc.MtlsCredentials;
import io.keel.core.auth.ScopeAuthoritiesConverter;
import io.keel.core.config.KeelProperties;
import io.keel.core.ports.SecretProvider;
import io.keel.reference.v1.ItemServiceGrpc;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.instrumentation.grpc.v1_6.GrpcTelemetry;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/**
 * Wires the inbound gRPC server only when a port is configured (ADR-0022, epic #419). Everything is
 * conditional on {@code keel.grpc-port} (env {@code KEEL_GRPC_PORT}), so a service without gRPC is
 * unaffected and its context starts unchanged; this mirrors the NATS adapter, which is wired only
 * when a broker URL is present. The deny-by-default posture is not optional: {@link
 * GrpcServerFactory} binds every service through {@link GrpcAuthInterceptor}, so enabling the port
 * cannot expose an unauthenticated servicer.
 *
 * <p>Transport posture follows the TLS config: when the cert, key, and CA PEM are all present (from
 * {@link SecretProvider} first, then {@link KeelProperties}) the server serves mTLS and requires a
 * client certificate; otherwise it serves plaintext for local/dev. The {@link JwtDecoder} bean is
 * the same one the HTTP resource server uses, so the gRPC and HTTP edges verify tokens identically.
 */
@AutoConfiguration
@ConditionalOnClass({Server.class, OpenTelemetry.class})
@ConditionalOnProperty(prefix = "keel", name = "grpc-port")
@EnableConfigurationProperties(KeelProperties.class)
public class GrpcServerAutoConfiguration {

  private static final Logger log = LoggerFactory.getLogger(GrpcServerAutoConfiguration.class);

  // Secret-store keys for the TLS PEM material; a SecretProvider entry wins over the configured
  // value so the private key can live in a secret store rather than the environment.
  static final String CERT_KEY = "KEEL_GRPC_TLS_CERT_PEM";
  static final String KEY_KEY = "KEEL_GRPC_TLS_KEY_PEM";
  static final String CA_KEY = "KEEL_GRPC_TLS_CA_PEM";

  /**
   * The deny-by-default auth interceptor, reusing the HTTP edge's JWT verification path and mapping
   * the committed contract's methods to the scopes ADR-0022 requires: GetItem/ListItems need {@code
   * items:read}, CreateItem needs {@code items:write}.
   */
  @Bean
  @ConditionalOnMissingBean
  public GrpcAuthInterceptor grpcAuthInterceptor(JwtDecoder jwtDecoder) {
    Map<String, Set<String>> requiredScopes =
        Map.of(
            ItemServiceGrpc.getGetItemMethod().getFullMethodName(), Set.of("items:read"),
            ItemServiceGrpc.getListItemsMethod().getFullMethodName(), Set.of("items:read"),
            ItemServiceGrpc.getCreateItemMethod().getFullMethodName(), Set.of("items:write"));
    return new GrpcAuthInterceptor(
        jwtDecoder, new ScopeAuthoritiesConverter(), requiredScopes, Set.of());
  }

  /** The OpenTelemetry gRPC tracing server interceptor (installed outermost by the factory). */
  @Bean
  @ConditionalOnMissingBean(name = "grpcTracingInterceptor")
  public ServerInterceptor grpcTracingInterceptor(OpenTelemetry openTelemetry) {
    return GrpcTelemetry.create(openTelemetry).createServerInterceptor();
  }

  /** The reference in-memory item servicer (ADR-0022). */
  @Bean
  @ConditionalOnMissingBean(InMemoryItemService.class)
  public InMemoryItemService inMemoryItemService() {
    return new InMemoryItemService();
  }

  /**
   * Build the server on the configured port with every {@link BindableService} bean wired through
   * the auth and tracing interceptors. mTLS when the full PEM triple is present, plaintext
   * otherwise.
   */
  @Bean
  @ConditionalOnMissingBean(Server.class)
  public Server grpcServer(
      KeelProperties properties,
      SecretProvider secretProvider,
      GrpcAuthInterceptor grpcAuthInterceptor,
      ServerInterceptor grpcTracingInterceptor,
      List<BindableService> services)
      throws IOException {
    ServerCredentials credentials = serverCredentials(properties, secretProvider);
    return GrpcServerFactory.create(
        properties.grpcPort(), credentials, grpcAuthInterceptor, grpcTracingInterceptor, services);
  }

  /** Start/stop the server with the application context. */
  @Bean
  @ConditionalOnMissingBean
  public GrpcServerLifecycle grpcServerLifecycle(Server grpcServer) {
    return new GrpcServerLifecycle(grpcServer);
  }

  private ServerCredentials serverCredentials(
      KeelProperties properties, SecretProvider secretProvider) throws IOException {
    String cert = resolve(secretProvider, CERT_KEY, properties.grpcTlsCertPem());
    String key = resolve(secretProvider, KEY_KEY, properties.grpcTlsKeyPem());
    String ca = resolve(secretProvider, CA_KEY, properties.grpcTlsCaPem());
    if (cert.isBlank() || key.isBlank() || ca.isBlank()) {
      log.warn(
          "gRPC TLS material incomplete; serving plaintext (no mTLS) on port {}",
          properties.grpcPort());
      return InsecureServerCredentials.create();
    }
    return MtlsCredentials.serverCredentials(cert, key, ca);
  }

  private static String resolve(SecretProvider secretProvider, String key, String fallback) {
    return secretProvider.get(key).filter(v -> !v.isBlank()).orElse(fallback);
  }
}
