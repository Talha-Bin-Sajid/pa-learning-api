import pg from 'pg';
import { Database, type QueryResult, type SqlExecutor } from './database.js';

// Keep calendar dates as 'YYYY-MM-DD' strings (no timezone shifting) and numerics as numbers.
pg.types.setTypeParser(1082, (v: string) => v); // date
pg.types.setTypeParser(1700, (v: string) => parseFloat(v)); // numeric
pg.types.setTypeParser(20, (v: string) => Number(v)); // int8 (counts)

export interface PgDatabaseOptions {
  connectionString: string;
  ssl: 'require' | 'verify' | 'disable';
  max: number;
}

export class PgDatabase extends Database {
  private readonly pool: pg.Pool;

  constructor(options: PgDatabaseOptions) {
    super();
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max,
      ssl: options.ssl === 'disable' ? false : { rejectUnauthorized: options.ssl === 'verify' },
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  protected async rawQuery<T>(executor: SqlExecutor | null, sql: string, params: unknown[]): Promise<QueryResult<T>> {
    if (executor) return executor.query<T>(sql, params);
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  protected async withTransaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: SqlExecutor = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        const res = await client.query(sql, params);
        return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
      },
    };
    try {
      await client.query('begin');
      const result = await work(tx);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
