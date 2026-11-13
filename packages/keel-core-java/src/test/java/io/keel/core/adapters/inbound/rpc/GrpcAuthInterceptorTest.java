package io.keel.core.adapters.inbound.rpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import io.keel.core.auth.ScopeAuthoritiesConverter;
import io.keel.reference.v1.GetItemRequest;
import io.keel.reference.v1.GetItemResponse;
import io.keel.reference.v1.ItemServiceGrpc;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.security.core.Authentication;

/**
 * Unit coverage for the interceptor branches the transport test does not reach: an exempt method
 * and a method with no declared scopes (authenticated-only). Drives {@link
 * GrpcAuthInterceptor#interceptCall} directly against a mocked call so the deny/close path and the
 * context-propagation path are both asserted.
 */
class GrpcAuthInterceptorTest {

  private static final String METHOD = ItemServiceGrpc.getGetItemMethod().getFullMethodName();

  @SuppressWarnings("unchecked")
  private static ServerCall<GetItemRequest, GetItemResponse> mockCall() {
    ServerCall<GetItemRequest, GetItemResponse> call = mock(ServerCall.class);
    when(call.getMethodDescriptor()).thenReturn(ItemServiceGrpc.getGetItemMethod());
    return call;
  }

  @Test
  void exemptMethodBypassesAuthEntirely() {
    GrpcAuthInterceptor interceptor =
        new GrpcAuthInterceptor(
            GrpcTestSupport.stubDecoder(),
            new ScopeAuthoritiesConverter(),
            Map.of(),
            Set.of(METHOD));
    ServerCall<GetItemRequest, GetItemResponse> call = mockCall();
    @SuppressWarnings("unchecked")
    ServerCallHandler<GetItemRequest, GetItemResponse> next = mock(ServerCallHandler.class);

    // No authorization header at all; an exempt method must still proceed to the handler.
    interceptor.interceptCall(call, new Metadata(), next);

    verify(next).startCall(any(), any());
    verify(call, never()).close(any(), any());
  }

  @Test
  void authenticatedCallWithNoRequiredScopesProceedsAndPublishesPrincipal() {
    GrpcAuthInterceptor interceptor =
        new GrpcAuthInterceptor(
            GrpcTestSupport.stubDecoder(), new ScopeAuthoritiesConverter(), Map.of(), Set.of());
    ServerCall<GetItemRequest, GetItemResponse> call = mockCall();
    @SuppressWarnings("unchecked")
    ServerCallHandler<GetItemRequest, GetItemResponse> next = mock(ServerCallHandler.class);
    AtomicReference<Authentication> seen = new AtomicReference<>();
    when(next.startCall(any(), any()))
        .thenAnswer(inv -> {
          seen.set(GrpcSecurityContext.currentAuthentication());
          return null;
        });

    interceptor.interceptCall(call, GrpcTestSupport.bearer(GrpcTestSupport.READ_TOKEN), next);

    verify(next).startCall(any(), any());
    assertThat(seen.get()).isNotNull();
    assertThat(seen.get().getName()).isEqualTo("svc-read");
  }

  @Test
  void missingTokenClosesUnauthenticatedWithoutInvokingHandler() {
    GrpcAuthInterceptor interceptor =
        new GrpcAuthInterceptor(
            GrpcTestSupport.stubDecoder(),
            new ScopeAuthoritiesConverter(),
            Map.of(METHOD, Set.of("items:read")),
            Set.of());
    ServerCall<GetItemRequest, GetItemResponse> call = mockCall();
    @SuppressWarnings("unchecked")
    ServerCallHandler<GetItemRequest, GetItemResponse> next = mock(ServerCallHandler.class);

    interceptor.interceptCall(call, new Metadata(), next);

    ArgumentCaptor<Status> status = ArgumentCaptor.forClass(Status.class);
    verify(call).close(status.capture(), any());
    assertThat(status.getValue().getCode()).isEqualTo(Status.Code.UNAUTHENTICATED);
    verify(next, never()).startCall(any(), any());
  }
}
