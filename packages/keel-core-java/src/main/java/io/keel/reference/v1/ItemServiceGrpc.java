package io.keel.reference.v1;

import static io.grpc.MethodDescriptor.generateFullMethodName;

/**
 * <pre>
 * Read and write slice of the reference aggregate (ADR-0022 option A1).
 * Required scopes are enforced by each vertical's server factory, not by proto
 * options: GetItem/ListItems require items:read, CreateItem requires items:write.
 * </pre>
 */
@io.grpc.stub.annotations.GrpcGenerated
public final class ItemServiceGrpc {

  private ItemServiceGrpc() {}

  public static final java.lang.String SERVICE_NAME = "keel.reference.v1.ItemService";

  // Static method descriptors that strictly reflect the proto.
  private static volatile io.grpc.MethodDescriptor<io.keel.reference.v1.GetItemRequest,
      io.keel.reference.v1.GetItemResponse> getGetItemMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "GetItem",
      requestType = io.keel.reference.v1.GetItemRequest.class,
      responseType = io.keel.reference.v1.GetItemResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<io.keel.reference.v1.GetItemRequest,
      io.keel.reference.v1.GetItemResponse> getGetItemMethod() {
    io.grpc.MethodDescriptor<io.keel.reference.v1.GetItemRequest, io.keel.reference.v1.GetItemResponse> getGetItemMethod;
    if ((getGetItemMethod = ItemServiceGrpc.getGetItemMethod) == null) {
      synchronized (ItemServiceGrpc.class) {
        if ((getGetItemMethod = ItemServiceGrpc.getGetItemMethod) == null) {
          ItemServiceGrpc.getGetItemMethod = getGetItemMethod =
              io.grpc.MethodDescriptor.<io.keel.reference.v1.GetItemRequest, io.keel.reference.v1.GetItemResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "GetItem"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  io.keel.reference.v1.GetItemRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  io.keel.reference.v1.GetItemResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ItemServiceMethodDescriptorSupplier("GetItem"))
              .build();
        }
      }
    }
    return getGetItemMethod;
  }

  private static volatile io.grpc.MethodDescriptor<io.keel.reference.v1.ListItemsRequest,
      io.keel.reference.v1.ListItemsResponse> getListItemsMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "ListItems",
      requestType = io.keel.reference.v1.ListItemsRequest.class,
      responseType = io.keel.reference.v1.ListItemsResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<io.keel.reference.v1.ListItemsRequest,
      io.keel.reference.v1.ListItemsResponse> getListItemsMethod() {
    io.grpc.MethodDescriptor<io.keel.reference.v1.ListItemsRequest, io.keel.reference.v1.ListItemsResponse> getListItemsMethod;
    if ((getListItemsMethod = ItemServiceGrpc.getListItemsMethod) == null) {
      synchronized (ItemServiceGrpc.class) {
        if ((getListItemsMethod = ItemServiceGrpc.getListItemsMethod) == null) {
          ItemServiceGrpc.getListItemsMethod = getListItemsMethod =
              io.grpc.MethodDescriptor.<io.keel.reference.v1.ListItemsRequest, io.keel.reference.v1.ListItemsResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "ListItems"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  io.keel.reference.v1.ListItemsRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  io.keel.reference.v1.ListItemsResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ItemServiceMethodDescriptorSupplier("ListItems"))
              .build();
        }
      }
    }
    return getListItemsMethod;
  }

  private static volatile io.grpc.MethodDescriptor<io.keel.reference.v1.CreateItemRequest,
      io.keel.reference.v1.CreateItemResponse> getCreateItemMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "CreateItem",
      requestType = io.keel.reference.v1.CreateItemRequest.class,
      responseType = io.keel.reference.v1.CreateItemResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<io.keel.reference.v1.CreateItemRequest,
      io.keel.reference.v1.CreateItemResponse> getCreateItemMethod() {
    io.grpc.MethodDescriptor<io.keel.reference.v1.CreateItemRequest, io.keel.reference.v1.CreateItemResponse> getCreateItemMethod;
    if ((getCreateItemMethod = ItemServiceGrpc.getCreateItemMethod) == null) {
      synchronized (ItemServiceGrpc.class) {
        if ((getCreateItemMethod = ItemServiceGrpc.getCreateItemMethod) == null) {
          ItemServiceGrpc.getCreateItemMethod = getCreateItemMethod =
              io.grpc.MethodDescriptor.<io.keel.reference.v1.CreateItemRequest, io.keel.reference.v1.CreateItemResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "CreateItem"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  io.keel.reference.v1.CreateItemRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  io.keel.reference.v1.CreateItemResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ItemServiceMethodDescriptorSupplier("CreateItem"))
              .build();
        }
      }
    }
    return getCreateItemMethod;
  }

  /**
   * Creates a new async stub that supports all call types for the service
   */
  public static ItemServiceStub newStub(io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ItemServiceStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ItemServiceStub>() {
        @java.lang.Override
        public ItemServiceStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ItemServiceStub(channel, callOptions);
        }
      };
    return ItemServiceStub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports all types of calls on the service
   */
  public static ItemServiceBlockingV2Stub newBlockingV2Stub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ItemServiceBlockingV2Stub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ItemServiceBlockingV2Stub>() {
        @java.lang.Override
        public ItemServiceBlockingV2Stub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ItemServiceBlockingV2Stub(channel, callOptions);
        }
      };
    return ItemServiceBlockingV2Stub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports unary and streaming output calls on the service
   */
  public static ItemServiceBlockingStub newBlockingStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ItemServiceBlockingStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ItemServiceBlockingStub>() {
        @java.lang.Override
        public ItemServiceBlockingStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ItemServiceBlockingStub(channel, callOptions);
        }
      };
    return ItemServiceBlockingStub.newStub(factory, channel);
  }

  /**
   * Creates a new ListenableFuture-style stub that supports unary calls on the service
   */
  public static ItemServiceFutureStub newFutureStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ItemServiceFutureStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ItemServiceFutureStub>() {
        @java.lang.Override
        public ItemServiceFutureStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ItemServiceFutureStub(channel, callOptions);
        }
      };
    return ItemServiceFutureStub.newStub(factory, channel);
  }

  /**
   * <pre>
   * Read and write slice of the reference aggregate (ADR-0022 option A1).
   * Required scopes are enforced by each vertical's server factory, not by proto
   * options: GetItem/ListItems require items:read, CreateItem requires items:write.
   * </pre>
   */
  public interface AsyncService {

    /**
     * <pre>
     * Fetch a single item by id. Requires scope items:read.
     * </pre>
     */
    default void getItem(io.keel.reference.v1.GetItemRequest request,
        io.grpc.stub.StreamObserver<io.keel.reference.v1.GetItemResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getGetItemMethod(), responseObserver);
    }

    /**
     * <pre>
     * List a page of items. Requires scope items:read.
     * </pre>
     */
    default void listItems(io.keel.reference.v1.ListItemsRequest request,
        io.grpc.stub.StreamObserver<io.keel.reference.v1.ListItemsResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getListItemsMethod(), responseObserver);
    }

    /**
     * <pre>
     * Create a new item. Requires scope items:write.
     * </pre>
     */
    default void createItem(io.keel.reference.v1.CreateItemRequest request,
        io.grpc.stub.StreamObserver<io.keel.reference.v1.CreateItemResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getCreateItemMethod(), responseObserver);
    }
  }

  /**
   * Base class for the server implementation of the service ItemService.
   * <pre>
   * Read and write slice of the reference aggregate (ADR-0022 option A1).
   * Required scopes are enforced by each vertical's server factory, not by proto
   * options: GetItem/ListItems require items:read, CreateItem requires items:write.
   * </pre>
   */
  public static abstract class ItemServiceImplBase
      implements io.grpc.BindableService, AsyncService {

    @java.lang.Override public final io.grpc.ServerServiceDefinition bindService() {
      return ItemServiceGrpc.bindService(this);
    }
  }

  /**
   * A stub to allow clients to do asynchronous rpc calls to service ItemService.
   * <pre>
   * Read and write slice of the reference aggregate (ADR-0022 option A1).
   * Required scopes are enforced by each vertical's server factory, not by proto
   * options: GetItem/ListItems require items:read, CreateItem requires items:write.
   * </pre>
   */
  public static final class ItemServiceStub
      extends io.grpc.stub.AbstractAsyncStub<ItemServiceStub> {
    private ItemServiceStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ItemServiceStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ItemServiceStub(channel, callOptions);
    }

    /**
     * <pre>
     * Fetch a single item by id. Requires scope items:read.
     * </pre>
     */
    public void getItem(io.keel.reference.v1.GetItemRequest request,
        io.grpc.stub.StreamObserver<io.keel.reference.v1.GetItemResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getGetItemMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     * <pre>
     * List a page of items. Requires scope items:read.
     * </pre>
     */
    public void listItems(io.keel.reference.v1.ListItemsRequest request,
        io.grpc.stub.StreamObserver<io.keel.reference.v1.ListItemsResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getListItemsMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     * <pre>
     * Create a new item. Requires scope items:write.
     * </pre>
     */
    public void createItem(io.keel.reference.v1.CreateItemRequest request,
        io.grpc.stub.StreamObserver<io.keel.reference.v1.CreateItemResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getCreateItemMethod(), getCallOptions()), request, responseObserver);
    }
  }

  /**
   * A stub to allow clients to do synchronous rpc calls to service ItemService.
   * <pre>
   * Read and write slice of the reference aggregate (ADR-0022 option A1).
   * Required scopes are enforced by each vertical's server factory, not by proto
   * options: GetItem/ListItems require items:read, CreateItem requires items:write.
   * </pre>
   */
  public static final class ItemServiceBlockingV2Stub
      extends io.grpc.stub.AbstractBlockingStub<ItemServiceBlockingV2Stub> {
    private ItemServiceBlockingV2Stub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ItemServiceBlockingV2Stub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ItemServiceBlockingV2Stub(channel, callOptions);
    }

    /**
     * <pre>
     * Fetch a single item by id. Requires scope items:read.
     * </pre>
     */
    public io.keel.reference.v1.GetItemResponse getItem(io.keel.reference.v1.GetItemRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getGetItemMethod(), getCallOptions(), request);
    }

    /**
     * <pre>
     * List a page of items. Requires scope items:read.
     * </pre>
     */
    public io.keel.reference.v1.ListItemsResponse listItems(io.keel.reference.v1.ListItemsRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getListItemsMethod(), getCallOptions(), request);
    }

    /**
     * <pre>
     * Create a new item. Requires scope items:write.
     * </pre>
     */
    public io.keel.reference.v1.CreateItemResponse createItem(io.keel.reference.v1.CreateItemRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getCreateItemMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do limited synchronous rpc calls to service ItemService.
   * <pre>
   * Read and write slice of the reference aggregate (ADR-0022 option A1).
   * Required scopes are enforced by each vertical's server factory, not by proto
   * options: GetItem/ListItems require items:read, CreateItem requires items:write.
   * </pre>
   */
  public static final class ItemServiceBlockingStub
      extends io.grpc.stub.AbstractBlockingStub<ItemServiceBlockingStub> {
    private ItemServiceBlockingStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ItemServiceBlockingStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ItemServiceBlockingStub(channel, callOptions);
    }

    /**
     * <pre>
     * Fetch a single item by id. Requires scope items:read.
     * </pre>
     */
    public io.keel.reference.v1.GetItemResponse getItem(io.keel.reference.v1.GetItemRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getGetItemMethod(), getCallOptions(), request);
    }

    /**
     * <pre>
     * List a page of items. Requires scope items:read.
     * </pre>
     */
    public io.keel.reference.v1.ListItemsResponse listItems(io.keel.reference.v1.ListItemsRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getListItemsMethod(), getCallOptions(), request);
    }

    /**
     * <pre>
     * Create a new item. Requires scope items:write.
     * </pre>
     */
    public io.keel.reference.v1.CreateItemResponse createItem(io.keel.reference.v1.CreateItemRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getCreateItemMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do ListenableFuture-style rpc calls to service ItemService.
   * <pre>
   * Read and write slice of the reference aggregate (ADR-0022 option A1).
   * Required scopes are enforced by each vertical's server factory, not by proto
   * options: GetItem/ListItems require items:read, CreateItem requires items:write.
   * </pre>
   */
  public static final class ItemServiceFutureStub
      extends io.grpc.stub.AbstractFutureStub<ItemServiceFutureStub> {
    private ItemServiceFutureStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ItemServiceFutureStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ItemServiceFutureStub(channel, callOptions);
    }

    /**
     * <pre>
     * Fetch a single item by id. Requires scope items:read.
     * </pre>
     */
    public com.google.common.util.concurrent.ListenableFuture<io.keel.reference.v1.GetItemResponse> getItem(
        io.keel.reference.v1.GetItemRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getGetItemMethod(), getCallOptions()), request);
    }

    /**
     * <pre>
     * List a page of items. Requires scope items:read.
     * </pre>
     */
    public com.google.common.util.concurrent.ListenableFuture<io.keel.reference.v1.ListItemsResponse> listItems(
        io.keel.reference.v1.ListItemsRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getListItemsMethod(), getCallOptions()), request);
    }

    /**
     * <pre>
     * Create a new item. Requires scope items:write.
     * </pre>
     */
    public com.google.common.util.concurrent.ListenableFuture<io.keel.reference.v1.CreateItemResponse> createItem(
        io.keel.reference.v1.CreateItemRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getCreateItemMethod(), getCallOptions()), request);
    }
  }

  private static final int METHODID_GET_ITEM = 0;
  private static final int METHODID_LIST_ITEMS = 1;
  private static final int METHODID_CREATE_ITEM = 2;

  private static final class MethodHandlers<Req, Resp> implements
      io.grpc.stub.ServerCalls.UnaryMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ServerStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ClientStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.BidiStreamingMethod<Req, Resp> {
    private final AsyncService serviceImpl;
    private final int methodId;

    MethodHandlers(AsyncService serviceImpl, int methodId) {
      this.serviceImpl = serviceImpl;
      this.methodId = methodId;
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public void invoke(Req request, io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        case METHODID_GET_ITEM:
          serviceImpl.getItem((io.keel.reference.v1.GetItemRequest) request,
              (io.grpc.stub.StreamObserver<io.keel.reference.v1.GetItemResponse>) responseObserver);
          break;
        case METHODID_LIST_ITEMS:
          serviceImpl.listItems((io.keel.reference.v1.ListItemsRequest) request,
              (io.grpc.stub.StreamObserver<io.keel.reference.v1.ListItemsResponse>) responseObserver);
          break;
        case METHODID_CREATE_ITEM:
          serviceImpl.createItem((io.keel.reference.v1.CreateItemRequest) request,
              (io.grpc.stub.StreamObserver<io.keel.reference.v1.CreateItemResponse>) responseObserver);
          break;
        default:
          throw new AssertionError();
      }
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public io.grpc.stub.StreamObserver<Req> invoke(
        io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        default:
          throw new AssertionError();
      }
    }
  }

  public static final io.grpc.ServerServiceDefinition bindService(AsyncService service) {
    return io.grpc.ServerServiceDefinition.builder(getServiceDescriptor())
        .addMethod(
          getGetItemMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              io.keel.reference.v1.GetItemRequest,
              io.keel.reference.v1.GetItemResponse>(
                service, METHODID_GET_ITEM)))
        .addMethod(
          getListItemsMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              io.keel.reference.v1.ListItemsRequest,
              io.keel.reference.v1.ListItemsResponse>(
                service, METHODID_LIST_ITEMS)))
        .addMethod(
          getCreateItemMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              io.keel.reference.v1.CreateItemRequest,
              io.keel.reference.v1.CreateItemResponse>(
                service, METHODID_CREATE_ITEM)))
        .build();
  }

  private static abstract class ItemServiceBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoFileDescriptorSupplier, io.grpc.protobuf.ProtoServiceDescriptorSupplier {
    ItemServiceBaseDescriptorSupplier() {}

    @java.lang.Override
    public com.google.protobuf.Descriptors.FileDescriptor getFileDescriptor() {
      return io.keel.reference.v1.ItemProto.getDescriptor();
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.ServiceDescriptor getServiceDescriptor() {
      return getFileDescriptor().findServiceByName("ItemService");
    }
  }

  private static final class ItemServiceFileDescriptorSupplier
      extends ItemServiceBaseDescriptorSupplier {
    ItemServiceFileDescriptorSupplier() {}
  }

  private static final class ItemServiceMethodDescriptorSupplier
      extends ItemServiceBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoMethodDescriptorSupplier {
    private final java.lang.String methodName;

    ItemServiceMethodDescriptorSupplier(java.lang.String methodName) {
      this.methodName = methodName;
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.MethodDescriptor getMethodDescriptor() {
      return getServiceDescriptor().findMethodByName(methodName);
    }
  }

  private static volatile io.grpc.ServiceDescriptor serviceDescriptor;

  public static io.grpc.ServiceDescriptor getServiceDescriptor() {
    io.grpc.ServiceDescriptor result = serviceDescriptor;
    if (result == null) {
      synchronized (ItemServiceGrpc.class) {
        result = serviceDescriptor;
        if (result == null) {
          serviceDescriptor = result = io.grpc.ServiceDescriptor.newBuilder(SERVICE_NAME)
              .setSchemaDescriptor(new ItemServiceFileDescriptorSupplier())
              .addMethod(getGetItemMethod())
              .addMethod(getListItemsMethod())
              .addMethod(getCreateItemMethod())
              .build();
        }
      }
    }
    return result;
  }
}
