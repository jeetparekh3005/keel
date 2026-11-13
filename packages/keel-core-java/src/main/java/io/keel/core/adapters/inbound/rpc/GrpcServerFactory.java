package io.keel.core.adapters.inbound.rpc;

import io.grpc.BindableService;
import io.grpc.Grpc;
import io.grpc.Server;
import io.grpc.ServerCredentials;
import io.grpc.ServerInterceptor;
import io.grpc.ServerInterceptors;
import io.grpc.ServerServiceDefinition;
import java.util.List;

/**
 * Builds the inbound gRPC {@link Server} with the auth and tracing interceptors installed by
 * construction (ADR-0022): every service handed to the factory is bound through {@link
 * GrpcAuthInterceptor} (deny-by-default auth + per-method scopes) and the OpenTelemetry server
 * interceptor, so there is no way to register a servicer that skips auth. This is the server-side
 * analog of the HTTP vertical, where {@link io.keel.core.auth.SecurityConfig} owns the one chain
 * every route passes through, and it mirrors the Python vertical's {@code create_server} factory.
 *
 * <p>The tracing interceptor is outermost (it opens the span first, so even a denied call is
 * recorded), the auth interceptor runs inside it, then the servicer. The {@link ServerCredentials}
 * decide the transport posture: {@link io.keel.core.adapters.outbound.rpc.MtlsCredentials} for
 * mTLS, or {@link io.grpc.InsecureServerCredentials} for a plaintext local/dev listener.
 */
public final class GrpcServerFactory {

  private GrpcServerFactory() {}

  /**
   * Bind {@code service} through the tracing and auth interceptors, preserving method cardinality.
   * Exposed so an in-process test server and the real port-bound server share the exact wiring.
   */
  public static ServerServiceDefinition intercepted(
      BindableService service, GrpcAuthInterceptor auth, ServerInterceptor tracing) {
    // interceptForward applies interceptors in listed order: tracing first (outermost), then auth.
    return ServerInterceptors.interceptForward(service, tracing, auth);
  }

  /**
   * Build (but do not start) a gRPC server on {@code port} with the given transport credentials,
   * every service wired through the auth and tracing interceptors.
   */
  public static Server create(
      int port,
      ServerCredentials credentials,
      GrpcAuthInterceptor auth,
      ServerInterceptor tracing,
      List<? extends BindableService> services) {
    var builder = Grpc.newServerBuilderForPort(port, credentials);
    for (BindableService service : services) {
      builder.addService(intercepted(service, auth, tracing));
    }
    return builder.build();
  }
}
