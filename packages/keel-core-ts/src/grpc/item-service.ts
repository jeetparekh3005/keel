import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { randomUUID } from 'node:crypto';

import {
  type CreateItemRequest,
  type GetItemRequest,
  type Item,
  ItemSchema,
  ItemService,
  type ListItemsRequest,
} from '../genproto/keel/reference/v1/item_pb.js';
import { grpcMethodPath } from './auth-interceptor.js';

/**
 * Per-method required scopes for ItemService (ADR-0022): GetItem/ListItems need items:read,
 * CreateItem needs items:write. Keyed by the gRPC method path the auth interceptor compares
 * against, derived from the generated descriptor so it cannot drift from the proto.
 */
export const ITEM_SERVICE_SCOPES: Record<string, readonly string[]> = {
  [grpcMethodPath(ItemService, ItemService.method.getItem)]: ['items:read'],
  [grpcMethodPath(ItemService, ItemService.method.listItems)]: ['items:read'],
  [grpcMethodPath(ItemService, ItemService.method.createItem)]: ['items:write'],
};

/**
 * A simple in-memory Item store backing the reference ItemService. It is the gRPC analogue of the
 * REST aggregate's store: enough to demonstrate the read/write slice end to end, not a durable
 * repository.
 */
export class InMemoryItemStore {
  private readonly items = new Map<string, Item>();

  /** The item with this id, or undefined when none exists. */
  get(id: string): Item | undefined {
    return this.items.get(id);
  }

  /**
   * A page of items: skip `offset` (when positive) then take `limit` (when positive, else the
   * remainder). Insertion order is preserved by the backing Map.
   */
  list(limit: number, offset: number): Item[] {
    const all = [...this.items.values()];
    const start = offset > 0 ? offset : 0;
    const end = limit > 0 ? start + limit : all.length;
    return all.slice(start, end);
  }

  /** Create and store a new item with a generated id, returning it. */
  create(name: string): Item {
    const item = create(ItemSchema, { id: randomUUID(), name });
    this.items.set(item.id, item);
    return item;
  }
}

/**
 * Register the reference ItemService on a ConnectRouter, backed by `store`. The handlers assume
 * the server factory's auth interceptor has already authenticated the caller and enforced the
 * per-method scopes (ITEM_SERVICE_SCOPES); they focus on the domain. GetItem is NotFound for an
 * unknown id and CreateItem is InvalidArgument for a blank name.
 */
export function registerItemService(
  router: ConnectRouter,
  store: InMemoryItemStore,
): ConnectRouter {
  return router.service(ItemService, {
    getItem(req: GetItemRequest) {
      const item = store.get(req.id);
      if (item === undefined) {
        throw new ConnectError(`item not found: ${req.id}`, Code.NotFound);
      }
      return { item };
    },
    listItems(req: ListItemsRequest) {
      return { items: store.list(req.limit, req.offset) };
    },
    createItem(req: CreateItemRequest) {
      if (req.name.trim().length === 0) {
        throw new ConnectError('item name must not be empty', Code.InvalidArgument);
      }
      return { item: store.create(req.name) };
    },
  });
}
