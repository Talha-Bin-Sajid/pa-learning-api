import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnitOfWork } from '../../application/ports/unit-of-work.js';

/** Minimal SQL surface the repositories depend on (implemented by pg and, in tests, PGlite). */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/**
 * A database that is also the UnitOfWork. Inside `run()`, every `query()`
 * transparently uses the transaction's connection (tracked with
 * AsyncLocalStorage), so repositories need no transaction plumbing.
 */
export abstract class Database implements SqlExecutor, UnitOfWork {
  private readonly txStore = new AsyncLocalStorage<SqlExecutor>();

  protected abstract rawQuery<T>(executor: SqlExecutor | null, sql: string, params: unknown[]): Promise<QueryResult<T>>;
  protected abstract withTransaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.rawQuery<T>(this.txStore.getStore() ?? null, sql, params);
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.txStore.getStore()) return work(); // already inside a transaction
    return this.withTransaction((tx) => this.txStore.run(tx, work));
  }
}
