import type { ProfileStatus, ReportingAccess, UserRole } from '../enums.js';

/** A member of the firm with a profile on the platform (table: profiles). */
export interface Person {
  id: string;
  authUserId: string | null;
  fullName: string;
  email: string;
  role: UserRole;
  designationId: number | null;
  reportingAccess: ReportingAccess;
  lineManagerId: string | null;
  status: ProfileStatus;
  avatarColor: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewPerson = Pick<
  Person,
  'fullName' | 'email' | 'role' | 'designationId' | 'reportingAccess' | 'lineManagerId' | 'status' | 'avatarColor'
> & { authUserId?: string | null };

export type PersonChanges = Partial<
  Pick<
    Person,
    'fullName' | 'email' | 'role' | 'designationId' | 'reportingAccess' | 'lineManagerId' | 'status' | 'authUserId'
  >
>;

/** Palette from the prototype; new people are assigned colours round-robin. */
export const AVATAR_COLORS = ['#2d8dfe', '#6663fb', '#57bfdf', '#3193b1', '#8843f8', '#ec4f3c', '#2c609c'] as const;

export function avatarColorFor(seed: number): string {
  return AVATAR_COLORS[Math.abs(seed) % AVATAR_COLORS.length]!;
}

export function initialsOf(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
