package io.keel.core.adapters.inbound.rpc;

import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import io.keel.reference.v1.CreateItemRequest;
import io.keel.reference.v1.CreateItemResponse;
import io.keel.reference.v1.GetItemRequest;
import io.keel.reference.v1.GetItemResponse;
import io.keel.reference.v1.Item;
import io.keel.reference.v1.ItemServiceGrpc;
import io.keel.reference.v1.ListItemsRequest;
import io.keel.reference.v1.ListItemsResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * A reference {@link ItemServiceGrpc.ItemServiceImplBase} over a simple in-memory store (ADR-0022).
 * It demonstrates the three methods of the committed contract end to end; persistence is out of
 * scope for this slice, so the store is a thread-safe map keyed by generated id. Authentication and
 * per-method scope authorization are enforced upstream by {@link GrpcAuthInterceptor}, so the
 * servicer itself holds no auth logic (the verified caller is available via {@link
 * GrpcSecurityContext#currentAuthentication()} for callers that need it).
 */
public class InMemoryItemService extends ItemServiceGrpc.ItemServiceImplBase {

  // ConcurrentHashMap guards concurrent calls; the id list carries insertion order for stable
  // paging (a ConcurrentHashMap does not preserve order), guarded by its own monitor.
  private final ConcurrentMap<String, Item> store = new ConcurrentHashMap<>();
  private final List<String> order = java.util.Collections.synchronizedList(new ArrayList<>());

  @Override
  public void getItem(GetItemRequest request, StreamObserver<GetItemResponse> responseObserver) {
    Item item = store.get(request.getId());
    if (item == null) {
      responseObserver.onError(
          Status.NOT_FOUND
              .withDescription("no item with id " + request.getId())
              .asRuntimeException());
      return;
    }
    responseObserver.onNext(GetItemResponse.newBuilder().setItem(item).build());
    responseObserver.onCompleted();
  }

  @Override
  public void listItems(
      ListItemsRequest request, StreamObserver<ListItemsResponse> responseObserver) {
    List<Item> page = new ArrayList<>();
    synchronized (order) {
      int offset = Math.max(0, request.getOffset());
      int limit = request.getLimit() > 0 ? request.getLimit() : order.size();
      for (int i = offset; i < order.size() && page.size() < limit; i++) {
        Item item = store.get(order.get(i));
        if (item != null) {
          page.add(item);
        }
      }
    }
    responseObserver.onNext(ListItemsResponse.newBuilder().addAllItems(page).build());
    responseObserver.onCompleted();
  }

  @Override
  public void createItem(
      CreateItemRequest request, StreamObserver<CreateItemResponse> responseObserver) {
    if (request.getName().isBlank()) {
      // Match the other verticals (Go/Rust/Python/TS): a blank name is a client error, not a stored
      // item with an empty name.
      responseObserver.onError(
          Status.INVALID_ARGUMENT
              .withDescription("item name must not be blank")
              .asRuntimeException());
      return;
    }
    String id = UUID.randomUUID().toString();
    Item item = Item.newBuilder().setId(id).setName(request.getName()).build();
    store.put(id, item);
    order.add(id);
    responseObserver.onNext(CreateItemResponse.newBuilder().setItem(item).build());
    responseObserver.onCompleted();
  }

  /** The current store contents keyed by id; for tests and diagnostics, not part of the RPC. */
  Map<String, Item> snapshot() {
    return Map.copyOf(store);
  }
}
