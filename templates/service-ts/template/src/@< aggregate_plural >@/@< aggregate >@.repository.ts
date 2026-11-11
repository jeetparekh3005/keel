import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Database, DATABASE, DomainError, ErrorCategory } from '@keel/core';

import { type @< aggregate_pascal >@, type @< aggregate_pascal >@Repository } from './@< aggregate >@.js';

/**
 * The Postgres-backed @< aggregate_pascal >@Repository. Ensures its table exists at startup (dev convenience;
 * production applies versioned migrations instead) and maps a missing row to a NotFound
 * DomainError and any driver failure to an Internal/Unavailable one, so internals never leak.
 */
@Injectable()
export class Pg@< aggregate_pascal >@Repository implements @< aggregate_pascal >@Repository, OnModuleInit {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  async ensureSchema(): Promise<void> {
    try {
      await this.db.raw.query(
        'CREATE TABLE IF NOT EXISTS @< aggregate_plural >@ (id text PRIMARY KEY, name text NOT NULL)',
      );
    } catch (err) {
      throw new DomainError(ErrorCategory.Unavailable, `ensure schema: ${errorText(err)}`);
    }
  }

  async create(@< aggregate >@: @< aggregate_pascal >@): Promise<void> {
    try {
      await this.db.raw.query('INSERT INTO @< aggregate_plural >@ (id, name) VALUES ($1, $2)', [@< aggregate >@.id, @< aggregate >@.name]);
    } catch (err) {
      throw new DomainError(ErrorCategory.Internal, `insert @< aggregate >@: ${errorText(err)}`);
    }
  }

  async get(id: string): Promise<@< aggregate_pascal >@> {
    let rows: @< aggregate_pascal >@[];
    try {
      const result = await this.db.raw.query<@< aggregate_pascal >@>('SELECT id, name FROM @< aggregate_plural >@ WHERE id = $1', [
        id,
      ]);
      rows = result.rows;
    } catch (err) {
      throw new DomainError(ErrorCategory.Internal, `get @< aggregate >@: ${errorText(err)}`);
    }
    if (rows.length === 0) {
      throw new DomainError(ErrorCategory.NotFound, '@< aggregate >@ not found');
    }
    return rows[0];
  }

  async list(limit: number, offset: number): Promise<@< aggregate_pascal >@[]> {
    try {
      const result = await this.db.raw.query<@< aggregate_pascal >@>(
        'SELECT id, name FROM @< aggregate_plural >@ ORDER BY id LIMIT $1 OFFSET $2',
        [limit, offset],
      );
      return result.rows;
    } catch (err) {
      throw new DomainError(ErrorCategory.Internal, `list @< aggregate_plural >@: ${errorText(err)}`);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
