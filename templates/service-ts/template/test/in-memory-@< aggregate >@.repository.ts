import { DomainError, ErrorCategory } from '@keel/core';

import type { @< aggregate_pascal >@, @< aggregate_pascal >@Repository } from '../src/@< aggregate_plural >@/@< aggregate >@.js';

/** A map-backed @< aggregate_pascal >@Repository for conformance and CRUD tests without a database. */
export class InMemory@< aggregate_pascal >@Repository implements @< aggregate_pascal >@Repository {
  private readonly @< aggregate_plural >@ = new Map<string, @< aggregate_pascal >@>();

  create(@< aggregate >@: @< aggregate_pascal >@): Promise<void> {
    this.@< aggregate_plural >@.set(@< aggregate >@.id, { ...@< aggregate >@ });
    return Promise.resolve();
  }

  get(id: string): Promise<@< aggregate_pascal >@> {
    const @< aggregate >@ = this.@< aggregate_plural >@.get(id);
    return @< aggregate >@
      ? Promise.resolve({ ...@< aggregate >@ })
      : Promise.reject(new DomainError(ErrorCategory.NotFound, '@< aggregate >@ not found'));
  }

  list(limit: number, offset: number): Promise<@< aggregate_pascal >@[]> {
    const sorted = [...this.@< aggregate_plural >@.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return Promise.resolve(sorted.slice(offset, offset + limit).map((@< aggregate >@) => ({ ...@< aggregate >@ })));
  }
}
