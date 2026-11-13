import { Database, DomainError, ErrorCategory } from '@keel/core';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Item } from './item.js';
import { PgItemRepository } from './item.repository.js';

// A row shape the fake pool returns; the repository reads `result.rows` off it.
type QueryResultLike = { rows: Item[] };
type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResultLike>;

// Build a repository over a fake pg pool so the SQL/params and the ORM<->domain mapping are
// exercised without a live Postgres (holds in the default, DB-free coverage run).
function repoWith(query: ReturnType<typeof vi.fn<QueryFn>>): PgItemRepository {
  const pool = { query } as unknown as Pool;
  return new PgItemRepository(new Database(pool));
}

describe('PgItemRepository (fake pg pool)', () => {
  let query: ReturnType<typeof vi.fn<QueryFn>>;
  let repo: PgItemRepository;

  beforeEach(() => {
    query = vi.fn<QueryFn>().mockResolvedValue({ rows: [] });
    repo = repoWith(query);
  });

  describe('ensureSchema / onModuleInit', () => {
    it('issues an idempotent CREATE TABLE for the items table', async () => {
      await repo.ensureSchema();
      expect(query).toHaveBeenCalledWith(
        'CREATE TABLE IF NOT EXISTS items (id text PRIMARY KEY, name text NOT NULL)',
      );
    });

    it('runs the schema bootstrap on module init', async () => {
      await repo.onModuleInit();
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS items');
    });

    it('maps a driver failure to an Unavailable DomainError without leaking the SQL', async () => {
      query.mockRejectedValueOnce(new Error('connection refused'));
      const err = await repo.ensureSchema().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).category).toBe(ErrorCategory.Unavailable);
      expect((err as DomainError).detail).toBe('ensure schema: connection refused');
    });
  });

  describe('create', () => {
    it('inserts with a parameterized statement and the item id + name as bind params', async () => {
      await repo.create({ id: 'id-1', name: 'widget' });
      expect(query).toHaveBeenCalledWith('INSERT INTO items (id, name) VALUES ($1, $2)', [
        'id-1',
        'widget',
      ]);
    });

    it('maps an insert failure to an Internal DomainError', async () => {
      query.mockRejectedValueOnce(new Error('duplicate key'));
      const err = await repo.create({ id: 'id-1', name: 'widget' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).category).toBe(ErrorCategory.Internal);
      expect((err as DomainError).detail).toBe('insert item: duplicate key');
    });

    it('stringifies a non-Error throwable in the detail', async () => {
      query.mockRejectedValueOnce('boom');
      const err = await repo.create({ id: 'id-1', name: 'widget' }).catch((e: unknown) => e);
      expect((err as DomainError).detail).toBe('insert item: boom');
    });
  });

  describe('get', () => {
    it('selects by id and maps the row to the domain item', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'id-1', name: 'widget' }] });
      const item = await repo.get('id-1');
      expect(query).toHaveBeenCalledWith('SELECT id, name FROM items WHERE id = $1', ['id-1']);
      expect(item).toEqual({ id: 'id-1', name: 'widget' });
    });

    it('throws a NotFound DomainError when no row matches', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      const err = await repo.get('missing').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).category).toBe(ErrorCategory.NotFound);
      expect((err as DomainError).detail).toBe('item not found');
    });

    it('maps a query failure to an Internal DomainError', async () => {
      query.mockRejectedValueOnce(new Error('read timeout'));
      const err = await repo.get('id-1').catch((e: unknown) => e);
      expect((err as DomainError).category).toBe(ErrorCategory.Internal);
      expect((err as DomainError).detail).toBe('get item: read timeout');
    });
  });

  describe('list', () => {
    it('pages with ORDER BY id and binds limit then offset', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { id: 'a', name: 'alpha' },
          { id: 'b', name: 'beta' },
        ],
      });
      const items = await repo.list(10, 20);
      expect(query).toHaveBeenCalledWith(
        'SELECT id, name FROM items ORDER BY id LIMIT $1 OFFSET $2',
        [10, 20],
      );
      expect(items).toEqual([
        { id: 'a', name: 'alpha' },
        { id: 'b', name: 'beta' },
      ]);
    });

    it('returns an empty page when the table yields no rows', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await repo.list(50, 0)).toEqual([]);
    });

    it('maps a query failure to an Internal DomainError', async () => {
      query.mockRejectedValueOnce(new Error('pool exhausted'));
      const err = await repo.list(50, 0).catch((e: unknown) => e);
      expect((err as DomainError).category).toBe(ErrorCategory.Internal);
      expect((err as DomainError).detail).toBe('list items: pool exhausted');
    });
  });
});
