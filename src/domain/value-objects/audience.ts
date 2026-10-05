import { ValidationError } from '../../shared/errors/app-errors.js';

/** Who a Learning Item applies to: everyone, or any mix of designations and named people. */
export interface Audience {
  all: boolean;
  designationIds: number[];
  profileIds: string[];
}

export const EVERYONE: Audience = Object.freeze({ all: true, designationIds: [], profileIds: [] }) as Audience;

/** Normalises and validates an audience. "Everyone" clears the lists; otherwise at least one target is required. */
export function toAudience(input: { all: boolean; designationIds?: number[]; profileIds?: string[] }): Audience {
  if (input.all) return { all: true, designationIds: [], profileIds: [] };
  const designationIds = [...new Set(input.designationIds ?? [])];
  const profileIds = [...new Set(input.profileIds ?? [])];
  if (designationIds.length === 0 && profileIds.length === 0) {
    throw new ValidationError('Choose who this item is for: everyone, designations or named people.', [
      { path: 'audience', message: 'No one selected' },
    ]);
  }
  return { all: false, designationIds, profileIds };
}

export function audienceIncludes(audience: Audience, person: { id: string; designationId: number | null }): boolean {
  if (audience.all) return true;
  if (person.designationId != null && audience.designationIds.includes(person.designationId)) return true;
  return audience.profileIds.includes(person.id);
}
