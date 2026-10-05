import type { ProfileStatus, ReportingAccess, UserRole, VisibilityScope } from '../enums.js';

/** The signed-in person, as far as authorization is concerned. */
export interface Actor {
  id: string;
  role: UserRole;
  reportingAccess: ReportingAccess;
  status: ProfileStatus;
}

export interface Permissions {
  /** Whose learning records this person may see. */
  scope: VisibilityScope;
  manageItems: boolean;
  manageCycles: boolean;
  manageUsers: boolean;
  manageReminders: boolean;
  /** Evidence Review page (all submissions). */
  reviewEvidence: boolean;
  /** Approve / reject evidence and re-run automatic checks (Learning Team only; HR is read-only). */
  decideEvidence: boolean;
  /** Dashboard / Team Progress / team report exports (scoped). */
  viewTeam: boolean;
}

/**
 * Visibility scope (decision D2):
 *   Learning Team, HR, or Full reporting access → all staff
 *   Manager (without full access)               → own team (direct reports)
 *   Everyone else                               → self
 */
export function visibilityScope(actor: Actor): VisibilityScope {
  if (actor.role === 'learning_team' || actor.role === 'hr' || actor.reportingAccess === 'full') return 'all';
  if (actor.role === 'manager') return 'team';
  return 'self';
}

export function permissionsFor(actor: Actor): Permissions {
  const scope = visibilityScope(actor);
  const isAdmin = actor.role === 'learning_team';
  return {
    scope,
    manageItems: isAdmin,
    manageCycles: isAdmin,
    manageUsers: isAdmin,
    manageReminders: isAdmin,
    reviewEvidence: isAdmin || actor.role === 'hr',
    decideEvidence: isAdmin,
    viewTeam: scope !== 'self',
  };
}

export type Capability = Exclude<keyof Permissions, 'scope'>;

export function can(actor: Actor, capability: Capability): boolean {
  return permissionsFor(actor)[capability];
}

/** May `actor` see `target`'s learning records? */
export function canViewPerson(actor: Actor, target: { id: string; lineManagerId: string | null }): boolean {
  if (actor.id === target.id) return true;
  switch (visibilityScope(actor)) {
    case 'all':
      return true;
    case 'team':
      return target.lineManagerId === actor.id;
    case 'self':
      return false;
  }
}
