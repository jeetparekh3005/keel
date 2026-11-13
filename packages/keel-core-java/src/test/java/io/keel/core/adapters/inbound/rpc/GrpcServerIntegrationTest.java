package io.keel.core.adapters.inbound.rpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.MetadataUtils;
import io.grpc.stub.StreamObserver;
import io.keel.core.auth.ScopeAuthoritiesConverter;
import io.keel.reference.v1.CreateItemRequest;
import io.keel.reference.v1.CreateItemResponse;
import io.keel.reference.v1.GetItemRequest;
import io.keel.reference.v1.Item;
import io.keel.reference.v1.ItemServiceGrpc;
import io.keel.reference.v1.ListItemsRequest;
import io.keel.reference.v1.ListItemsResponse;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.instrumentation.grpc.v1_6.GrpcTelemetry;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.Authentication;

/**
 * End-to-end gRPC auth over an in-process transport: deny-by-default authentication, per-method
 * scope authorization, and principal propagation are exercised through a real channel and the real
 * {@link GrpcAuthInterceptor} + {@link InMemoryItemService}, wired exactly as the server factory
 * wires them. No literal JWT: the stub decoder maps opaque test tokens to minted Jwts.
 */
class GrpcServerIntegrationTest {

  private Server server;
  private ManagedChannel channel;
  private final AtomicReference<Authentication> principalSeen = new AtomicReference<>();

  @BeforeEach
  void startServer() throws Exception {
    // Capture the principal the servicer sees, to prove the interceptor publishes it on the
    // context.
    InMemoryItemService service =
        new InMemoryItemService() {
          @Override
          public void createItem(
              CreateItemRequest request, StreamObserver<CreateItemResponse> responseObserver) {
            principalSeen.set(GrpcSecurityContext.currentAuthentication());
            super.createItem(request, responseObserver);
          }
        };
    GrpcAuthInterceptor auth =
        new GrpcAuthInterceptor(
            GrpcTestSupport.stubDecoder(),
            new ScopeAuthoritiesConverter(),
            Map.of(
                ItemServiceGrpc.getGetItemMethod().getFullMethodName(), Set.of("items:read"),
                ItemServiceGrpc.getListItemsMethod().getFullMethodName(), Set.of("items:read"),
                ItemServiceGrpc.getCreateItemMethod().getFullMethodName(), Set.of("items:write")),
            Set.of());
    ServerInterceptor tracing =
        GrpcTelemetry.create(OpenTelemetry.noop()).createServerInterceptor();
    String name = InProcessServerBuilder.generateName();
    server =
        InProcessServerBuilder.forName(name)
            .directExecutor()
            .addService(GrpcServerFactory.intercepted(service, auth, tracing))
            .build()
            .start();
    channel = InProcessChannelBuilder.forName(name).directExecutor().build();
  }

  @AfterEach
  void stopServer() throws Exception {
    channel.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
    server.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
  }

  private ItemServiceGrpc.ItemServiceBlockingStub stub(Metadata metadata) {
    return ItemServiceGrpc.newBlockingStub(channel)
        .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(metadata));
  }

  @Test
  void callWithoutTokenIsUnauthenticated() {
    assertThatThrownBy(() ->
            ItemServiceGrpc.newBlockingStub(channel)
                .getItem(GetItemRequest.newBuilder().setId("x").build()))
        .isInstanceOf(StatusRuntimeException.class)
        .extracting(e -> ((StatusRuntimeException) e).getStatus().getCode())
        .isEqualTo(Status.Code.UNAUTHENTICATED);
  }

  @Test
  void malformedAuthorizationHeaderIsUnauthenticated() {
    Metadata md = new Metadata();
    md.put(GrpcTestSupport.AUTHORIZATION, "Basic dXNlcjpwYXNz");
    assertThatThrownBy(() -> stub(md).getItem(GetItemRequest.newBuilder().setId("x").build()))
        .isInstanceOf(StatusRuntimeException.class)
        .extracting(e -> ((StatusRuntimeException) e).getStatus().getCode())
        .isEqualTo(Status.Code.UNAUTHENTICATED);
  }

  @Test
  void invalidTokenIsUnauthenticated() {
    assertThatThrownBy(() ->
            stub(GrpcTestSupport.bearer("bogus"))
                .getItem(GetItemRequest.newBuilder().setId("x").build()))
        .isInstanceOf(StatusRuntimeException.class)
        .extracting(e -> ((StatusRuntimeException) e).getStatus().getCode())
        .isEqualTo(Status.Code.UNAUTHENTICATED);
  }

  @Test
  void readScopeCannotCreateIsPermissionDenied() {
    assertThatThrownBy(() ->
            stub(GrpcTestSupport.bearer(GrpcTestSupport.READ_TOKEN))
                .createItem(CreateItemRequest.newBuilder().setName("widget").build()))
        .isInstanceOf(StatusRuntimeException.class)
        .extracting(e -> ((StatusRuntimeException) e).getStatus().getCode())
        .isEqualTo(Status.Code.PERMISSION_DENIED);
  }

  @Test
  void writeScopeCreatesAndPropagatesPrincipal() {
    CreateItemResponse created =
        stub(GrpcTestSupport.bearer(GrpcTestSupport.WRITE_TOKEN))
            .createItem(CreateItemRequest.newBuilder().setName("widget").build());
    assertThat(created.getItem().getName()).isEqualTo("widget");
    assertThat(created.getItem().getId()).isNotBlank();
    // The servicer saw the authenticated caller the interceptor published on the gRPC context.
    assertThat(principalSeen.get()).isNotNull();
    assertThat(principalSeen.get().getName()).isEqualTo("svc-write");
  }

  @Test
  void readScopeCanGetAndListAfterWriteSeeds() {
    CreateItemResponse created =
        stub(GrpcTestSupport.bearer(GrpcTestSupport.WRITE_TOKEN))
            .createItem(CreateItemRequest.newBuilder().setName("gadget").build());
    String id = created.getItem().getId();

    Item got =
        stub(GrpcTestSupport.bearer(GrpcTestSupport.READ_TOKEN))
            .getItem(GetItemRequest.newBuilder().setId(id).build())
            .getItem();
    assertThat(got.getName()).isEqualTo("gadget");

    ListItemsResponse listed =
        stub(GrpcTestSupport.bearer(GrpcTestSupport.READ_TOKEN))
            .listItems(ListItemsRequest.newBuilder().build());
    assertThat(listed.getItemsList()).extracting(Item::getId).contains(id);
  }

  @Test
  void getUnknownItemIsNotFound() {
    assertThatThrownBy(() ->
            stub(GrpcTestSupport.bearer(GrpcTestSupport.READ_TOKEN))
                .getItem(GetItemRequest.newBuilder().setId("missing").build()))
        .isInstanceOf(StatusRuntimeException.class)
        .extracting(e -> ((StatusRuntimeException) e).getStatus().getCode())
        .isEqualTo(Status.Code.NOT_FOUND);
  }
}
