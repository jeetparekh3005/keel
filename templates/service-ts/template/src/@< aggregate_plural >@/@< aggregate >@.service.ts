import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { type @< aggregate_pascal >@, type @< aggregate_pascal >@Repository, @< aggregate_upper >@_REPOSITORY } from './@< aggregate >@.js';

/** The application service for the @< aggregate_plural >@ aggregate. */
@Injectable()
export class @< aggregate_pascal >@Service {
  constructor(@Inject(@< aggregate_upper >@_REPOSITORY) private readonly repo: @< aggregate_pascal >@Repository) {}

  /** Persist a new @< aggregate >@ with a generated id. */
  async create(name: string): Promise<@< aggregate_pascal >@> {
    const @< aggregate >@: @< aggregate_pascal >@ = { id: randomUUID(), name };
    await this.repo.create(@< aggregate >@);
    return @< aggregate >@;
  }

  /** Return the @< aggregate >@ by id (NotFound if absent). */
  get(id: string): Promise<@< aggregate_pascal >@> {
    return this.repo.get(id);
  }

  /** Return a page of @< aggregate_plural >@. */
  list(limit: number, offset: number): Promise<@< aggregate_pascal >@[]> {
    return this.repo.list(limit, offset);
  }
}
