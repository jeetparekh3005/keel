import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Database, DATABASE, DomainError, ErrorCategory } from '@keel/core';

import { type Item, type ItemRepository } from './item.js';

/**
 * The Postgres-backed ItemRepository. Ensures its table exists at startup (dev convenience;
 * production applies versioned migrations instead) and maps a missing row to a NotFound
 * DomainError and any driver failure to an Internal/Unavailable one, so internals never leak.
 */
@Injectable()
export class PgItemRepository implements ItemRepository, OnModuleInit {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  async ensureSchema(): Promise<void> {
    try {
      await this.db.raw.query(
        'CREATE TABLE IF NOT EXISTS items (id text PRIMARY KEY, name text NOT NULL)',
      );
    } catch (err) {
      throw new DomainError(ErrorCategory.Unavailable, `ensure schema: ${errorText(err)}`);
    }
  }

  async create(item: Item): Promise<void> {
    try {
      await this.db.raw.query('INSERT INTO items (id, name) VALUES ($1, $2)', [item.id, item.name]);
    } catch (err) {
      throw new DomainError(ErrorCategory.Internal, `insert item: ${errorText(err)}`);
    }
  }

  async get(id: string): Promise<Item> {
    let rows: Item[];
    try {
      const result = await this.db.raw.query<Item>('SELECT id, name FROM items WHERE id = $1', [
        id,
      ]);
      rows = result.rows;
    } catch (err) {
      throw new DomainError(ErrorCategory.Internal, `get item: ${errorText(err)}`);
    }
    if (rows.length === 0) {
      throw new DomainError(ErrorCategory.NotFound, 'item not found');
    }
    return rows[0];
  }

  async list(limit: number, offset: number): Promise<Item[]> {
    try {
      const result = await this.db.raw.query<Item>(
        'SELECT id, name FROM items ORDER BY id LIMIT $1 OFFSET $2',
        [limit, offset],
      );
      return result.rows;
    } catch (err) {
      throw new DomainError(ErrorCategory.Internal, `list items: ${errorText(err)}`);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
