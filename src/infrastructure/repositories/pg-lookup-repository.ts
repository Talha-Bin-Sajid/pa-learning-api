import type { Designation, LookupEntry, Lookups } from '../../domain/entities/lookups.js';
import type { LookupRepository } from '../../domain/repositories/lookup-repository.js';
import type { SqlExecutor } from '../database/database.js';

interface DesignationRow {
  id: number;
  name: string;
  rank: number;
  grants_full_access: boolean;
  is_active: boolean;
}

interface EntryRow {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
}

const toDesignation = (r: DesignationRow): Designation => ({
  id: r.id,
  name: r.name,
  rank: r.rank,
  grantsFullAccess: r.grants_full_access,
  isActive: r.is_active,
});

const toEntry = (r: EntryRow): LookupEntry => ({ id: r.id, name: r.name, sortOrder: r.sort_order, isActive: r.is_active });

/** Reference lists change rarely; cached in memory for a short time. */
export class PgLookupRepository implements LookupRepository {
  private cache: { value: Lookups; expires: number } | null = null;

  constructor(
    private readonly db: SqlExecutor,
    private readonly ttlMs = 60_000,
  ) {}

  async all(): Promise<Lookups> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.value;
    const [designations, categories, cpdTypes, deliveryTypes] = await Promise.all([
      this.db.query<DesignationRow>('select id, name, rank, grants_full_access, is_active from designations order by rank'),
      this.db.query<EntryRow>('select id, name, sort_order, is_active from categories order by sort_order, name'),
      this.db.query<EntryRow>('select id, name, sort_order, is_active from cpd_types order by sort_order, name'),
      this.db.query<EntryRow>('select id, name, sort_order, is_active from delivery_types order by sort_order, name'),
    ]);
    const value: Lookups = {
      designations: designations.rows.map(toDesignation),
      categories: categories.rows.map(toEntry),
      cpdTypes: cpdTypes.rows.map(toEntry),
      deliveryTypes: deliveryTypes.rows.map(toEntry),
    };
    this.cache = { value, expires: Date.now() + this.ttlMs };
    return value;
  }

  async findDesignation(id: number): Promise<Designation | null> {
    return (await this.all()).designations.find((d) => d.id === id) ?? null;
  }
}
