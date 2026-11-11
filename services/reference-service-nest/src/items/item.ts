// The items aggregate, its repository port, and the application service. The reference
// service imports @keel/core and implements one aggregate against the platform contract
// (ADR-0009, ADR-0019).

/** The aggregate. */
export interface Item {
  id: string;
  name: string;
}

/** The driven port for item persistence. `get` returns a NotFound DomainError when absent. */
export interface ItemRepository {
  create(item: Item): Promise<void>;
  get(id: string): Promise<Item>;
  list(limit: number, offset: number): Promise<Item[]>;
}

/** DI token for the item repository (bound to the Postgres adapter in production). */
export const ITEM_REPOSITORY = Symbol('reference.ItemRepository');
