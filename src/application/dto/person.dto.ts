import type { Person } from '../../domain/entities/person.js';
import { initialsOf } from '../../domain/entities/person.js';
import type { Designation } from '../../domain/entities/lookups.js';
import type { ProfileStatus, ReportingAccess, UserRole } from '../../domain/enums.js';

export interface PersonDto {
  id: string;
  fullName: string;
  email: string;
  initials: string;
  avatarColor: string | null;
  role: UserRole;
  designation: { id: number; name: string } | null;
  reportingAccess: ReportingAccess;
  lineManager: { id: string; fullName: string } | null;
  status: ProfileStatus;
  /** Has the person ever signed in (an auth account is linked)? */
  hasAccount: boolean;
}

/** Lookup context needed to render people (designation names, manager names). */
export interface PersonDtoContext {
  designations: Map<number, Designation>;
  peopleById: Map<string, Pick<Person, 'id' | 'fullName'>>;
}

export function toPersonDto(person: Person, ctx: PersonDtoContext): PersonDto {
  const designation = person.designationId != null ? ctx.designations.get(person.designationId) : undefined;
  const manager = person.lineManagerId ? ctx.peopleById.get(person.lineManagerId) : undefined;
  return {
    id: person.id,
    fullName: person.fullName,
    email: person.email,
    initials: initialsOf(person.fullName),
    avatarColor: person.avatarColor,
    role: person.role,
    designation: designation ? { id: designation.id, name: designation.name } : null,
    reportingAccess: person.reportingAccess,
    lineManager: manager ? { id: manager.id, fullName: manager.fullName } : null,
    status: person.status,
    hasAccount: person.authUserId !== null,
  };
}
