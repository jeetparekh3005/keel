import { DomainError, ErrorCategory } from '@keel/core';

import type { Item, ItemRepository } from '../src/items/item.js';

/** A map-backed ItemRepository for conformance and CRUD tests without a database. */
export class InMemoryItemRepository implements ItemRepository {
  private readonly items = new Map<string, Item>();

  create(item: Item): Promise<void> {
    this.items.set(item.id, { ...item });
    return Promise.resolve();
  }

  get(id: string): Promise<Item> {
    const item = this.items.get(id);
    return item
      ? Promise.resolve({ ...item })
      : Promise.reject(new DomainError(ErrorCategory.NotFound, 'item not found'));
  }

  list(limit: number, offset: number): Promise<Item[]> {
    const sorted = [...this.items.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return Promise.resolve(sorted.slice(offset, offset + limit).map((item) => ({ ...item })));
  }
}
