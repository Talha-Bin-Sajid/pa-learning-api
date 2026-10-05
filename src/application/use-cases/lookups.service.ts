import type { Lookups } from '../../domain/entities/lookups.js';
import type { LookupRepository } from '../../domain/repositories/lookup-repository.js';

export class LookupsService {
  constructor(private readonly lookups: LookupRepository) {}

  /** Active reference lists for forms and filters. */
  async get(): Promise<Lookups> {
    const all = await this.lookups.all();
    return {
      designations: all.designations.filter((d) => d.isActive),
      categories: all.categories.filter((c) => c.isActive),
      cpdTypes: all.cpdTypes.filter((c) => c.isActive),
      deliveryTypes: all.deliveryTypes.filter((c) => c.isActive),
    };
  }
}
