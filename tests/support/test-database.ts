import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite, types } from '@electric-sql/pglite';
import { Database, type QueryResult, type SqlExecutor } from '../../src/infrastructure/database/database.js';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../supabase/migrations');

/** Same type parsing as PgDatabase: dates stay 'YYYY-MM-DD', numerics become numbers. */
const parsers = {
  [types.DATE]: (v: string) => v,
  [types.NUMERIC]: (v: string) => parseFloat(v),
  [types.INT8]: (v: string) => Number(v),
};

/** Fresh in-process Postgres with every Supabase migration applied, in order. */
export async function createMigratedDatabase(): Promise<PGlite> {
  const db = new PGlite({ parsers });
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

/** The production Database abstraction backed by PGlite, so repositories run their real SQL in tests. */
export class PGliteDatabase extends Database {
  constructor(readonly pglite: PGlite) {
    super();
  }

  static async create(): Promise<PGliteDatabase> {
    return new PGliteDatabase(await createMigratedDatabase());
  }

  protected async rawQuery<T>(executor: SqlExecutor | null, sql: string, params: unknown[]): Promise<QueryResult<T>> {
    if (executor) return executor.query<T>(sql, params);
    const res = await this.pglite.query<T>(sql, params);
    return { rows: res.rows, rowCount: res.rows.length || (res.affectedRows ?? 0) };
  }

  protected withTransaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pglite.transaction(async (tx) =>
      work({
        query: async <R>(sql: string, params: unknown[] = []) => {
          const res = await tx.query<R>(sql, params);
          return { rows: res.rows, rowCount: res.rows.length || (res.affectedRows ?? 0) };
        },
      }),
    );
  }

  async close(): Promise<void> {
    await this.pglite.close();
  }
}
