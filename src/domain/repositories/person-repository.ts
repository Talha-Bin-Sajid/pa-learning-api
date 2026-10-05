import type { NewPerson, Person, PersonChanges } from '../entities/person.js';
import type { ProfileStatus, UserRole } from '../enums.js';

export interface PersonFilter {
  search?: string;
  role?: UserRole;
  status?: ProfileStatus;
  /** Restrict to these ids (visibility scoping). */
  ids?: string[];
  lineManagerId?: string;
}

export interface PersonRepository {
  findById(id: string): Promise<Person | null>;
  findByAuthUserId(authUserId: string): Promise<Person | null>;
  findByEmail(email: string): Promise<Person | null>;
  findByEmails(emails: string[]): Promise<Person[]>;
  list(filter?: PersonFilter): Promise<Person[]>;
  count(): Promise<number>;
  create(person: NewPerson): Promise<Person>;
  update(id: string, changes: PersonChanges): Promise<Person>;
  touchLastSeen(id: string): Promise<void>;
}
