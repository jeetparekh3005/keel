package io.keel.core.adapters.inbound.rpc;

import io.grpc.Context;
import org.springframework.security.core.Authentication;

/**
 * Publishes the authenticated caller on the gRPC {@link Context} so a servicer can read it without
 * a thread-local or a method parameter (the gRPC analog of Spring Security's {@code
 * SecurityContextHolder}, and of the Python vertical's {@code principal_var} contextvar). {@link
 * GrpcAuthInterceptor} sets the key after it verifies the token and the method's scopes; the
 * servicer reads it with {@link #currentAuthentication()}. The value is only ever set on an already
 * authenticated-and-authorized call, so its presence is itself the proof the call passed auth.
 */
public final class GrpcSecurityContext {

  /** The gRPC context key carrying the verified {@link Authentication} for the current call. */
  public static final Context.Key<Authentication> AUTHENTICATION =
      Context.key("keel.grpc.authentication");

  private GrpcSecurityContext() {}

  /** The authenticated caller bound to the current gRPC call, or {@code null} outside one. */
  public static Authentication currentAuthentication() {
    return AUTHENTICATION.get();
  }
}
