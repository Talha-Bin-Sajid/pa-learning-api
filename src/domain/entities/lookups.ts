/** Reference lists (tables: designations, categories, cpd_types, delivery_types). */

export interface Designation {
  id: number;
  name: string;
  rank: number;
  grantsFullAccess: boolean;
  isActive: boolean;
}

export interface LookupEntry {
  id: number;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface Lookups {
  designations: Designation[];
  categories: LookupEntry[];
  cpdTypes: LookupEntry[];
  deliveryTypes: LookupEntry[];
}
