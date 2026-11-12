// Database plumbing (platform.yaml persistence): a pg connection pool as Database and a
// UnitOfWork transaction boundary. Like the other verticals it ships the plumbing, not a
// generic repository: each service defines its own repository per aggregate and maps rows to
// domain types (ADR-0009).
import { Pool, type PoolClient } from 'pg';

import { DomainError, ErrorCategory } from '../domain/errors.js';

/** DI token for the Database. */
export const DATABASE = Symbol('keel.Database');

/** Pool usage, for the saturation (fourth golden) signal. */
export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
  /** Maximum connections the pool allows: the saturation denominator. */
  max: number;
}

/** A Postgres connection pool. */
export class Database {
  constructor(private readonly pool: Pool) {}

  /** Open a pool for url (postgres://...) and verify connectivity (fail-fast). */
  static async connect(url: string): Promise<Database> {
    const pool = new Pool({ connectionString: url });
    try {
      await pool.query('SELECT 1');
    } catch (err) {
      await pool.end();
      throw new DomainError(ErrorCategory.Unavailable, `database connect: ${errorText(err)}`);
    }
    return new Database(pool);
  }

  /** The underlying pool, for executing queries outside a unit of work. */
  get raw(): Pool {
    return this.pool;
  }

  /** Readiness: true if a trivial round-trip to the datasource succeeds. */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Current pool usage. */
  stats(): PoolStats {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      max: this.pool.options.max,
    };
  }

  /** Release the pool. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Start a transactional unit of work. */
  async begin(): Promise<UnitOfWork> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
    } catch (err) {
      client.release();
      throw new DomainError(ErrorCategory.Unavailable, `begin transaction: ${errorText(err)}`);
    }
    return new UnitOfWork(client);
  }

  /**
   * Run fn inside a unit of work: commit on success, roll back on any thrown error. The
   * ergonomic default so a block that throws never persists a partial write.
   */
  async withTransaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const uow = await this.begin();
    try {
      const result = await fn(uow);
      await uow.commit();
      return result;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

/**
 * A transaction boundary over a pooled client. Commit is explicit. Rollback after a Commit
 * (or a second time) is a safe no-op, so it can always be the catch-path. Either terminal
 * call releases the client back to the pool.
 */
export class UnitOfWork {
  private settled = false;

  constructor(private readonly client: PoolClient) {}

  /** The client the repository executes against inside the transaction. */
  get tx(): PoolClient {
    return this.client;
  }

  /** Persist the unit of work. */
  async commit(): Promise<void> {
    if (this.settled) {
      return;
    }
    this.settled = true;
    try {
      await this.client.query('COMMIT');
    } catch (err) {
      this.client.release();
      throw new DomainError(ErrorCategory.Internal, `commit: ${errorText(err)}`);
    }
    this.client.release();
  }

  /** Abort the unit of work. Safe to call after commit or twice; always releases the client. */
  async rollback(): Promise<void> {
    if (this.settled) {
      return;
    }
    this.settled = true;
    try {
      await this.client.query('ROLLBACK');
    } catch {
      // Already closed; nothing to abort.
    }
    this.client.release();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
