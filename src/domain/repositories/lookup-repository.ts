import type { Designation, Lookups } from '../entities/lookups.js';

export interface LookupRepository {
  all(): Promise<Lookups>;
  findDesignation(id: number): Promise<Designation | null>;
}
