import { describe, expect, it } from 'vitest';
import { canViewPerson, permissionsFor, visibilityScope, type Actor } from '../../src/domain/services/access-policy.js';
import { defaultReportingAccess } from '../../src/domain/services/reporting-access.js';

const actor = (over: Partial<Actor>): Actor => ({
  id: 'me',
  role: 'team_member',
  reportingAccess: 'self',
  status: 'active',
  ...over,
});

describe('visibilityScope (decision D2)', () => {
  it.each([
    ['learning_team', 'self', 'all'],
    ['hr', 'self', 'all'],
    ['manager', 'self', 'team'],
    ['manager', 'full', 'all'],
    ['team_member', 'self', 'self'],
    ['team_member', 'full', 'all'],
  ] as const)('%s with %s access sees %s', (role, reportingAccess, expected) => {
    expect(visibilityScope(actor({ role, reportingAccess }))).toBe(expected);
  });
});

describe('permissionsFor', () => {
  it('gives the Learning Team every admin capability', () => {
    expect(permissionsFor(actor({ role: 'learning_team' }))).toEqual({
      scope: 'all',
      manageItems: true,
      manageCycles: true,
      manageUsers: true,
      manageReminders: true,
      reviewEvidence: true,
      decideEvidence: true,
      viewTeam: true,
    });
  });

  it('lets HR review evidence and view the team, but not manage anything', () => {
    const p = permissionsFor(actor({ role: 'hr' }));
    expect(p).toMatchObject({ reviewEvidence: true, decideEvidence: false, viewTeam: true, manageItems: false, manageUsers: false });
  });

  it('lets a manager view (their) team only', () => {
    const p = permissionsFor(actor({ role: 'manager' }));
    expect(p).toMatchObject({ scope: 'team', viewTeam: true, reviewEvidence: false, manageItems: false });
  });

  it('keeps a team member to their own learning', () => {
    expect(permissionsFor(actor({})).viewTeam).toBe(false);
  });
});

describe('canViewPerson', () => {
  const report = { id: 'report', lineManagerId: 'me' };
  const stranger = { id: 'stranger', lineManagerId: 'someone-else' };

  it('always allows seeing yourself', () => {
    expect(canViewPerson(actor({}), { id: 'me', lineManagerId: null })).toBe(true);
  });

  it('lets a manager see direct reports but not other teams', () => {
    const m = actor({ role: 'manager' });
    expect(canViewPerson(m, report)).toBe(true);
    expect(canViewPerson(m, stranger)).toBe(false);
  });

  it('lets full-access people see anyone', () => {
    expect(canViewPerson(actor({ reportingAccess: 'full' }), stranger)).toBe(true);
  });

  it('stops a team member seeing colleagues', () => {
    expect(canViewPerson(actor({}), report)).toBe(false);
  });
});

describe('defaultReportingAccess', () => {
  it('is full for Learning Team, HR and Director/Partner designations', () => {
    expect(defaultReportingAccess('learning_team', false)).toBe('full');
    expect(defaultReportingAccess('hr', false)).toBe('full');
    expect(defaultReportingAccess('manager', true)).toBe('full');
    expect(defaultReportingAccess('team_member', true)).toBe('full');
  });

  it('is self otherwise', () => {
    expect(defaultReportingAccess('manager', false)).toBe('self');
    expect(defaultReportingAccess('team_member', false)).toBe('self');
  });
});
