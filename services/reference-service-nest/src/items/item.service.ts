import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { type Item, type ItemRepository, ITEM_REPOSITORY } from './item.js';

/** The application service for the items aggregate. */
@Injectable()
export class ItemService {
  constructor(@Inject(ITEM_REPOSITORY) private readonly repo: ItemRepository) {}

  /** Persist a new item with a generated id. */
  async create(name: string): Promise<Item> {
    const item: Item = { id: randomUUID(), name };
    await this.repo.create(item);
    return item;
  }

  /** Return the item by id (NotFound if absent). */
  get(id: string): Promise<Item> {
    return this.repo.get(id);
  }

  /** Return a page of items. */
  list(limit: number, offset: number): Promise<Item[]> {
    return this.repo.list(limit, offset);
  }
}
