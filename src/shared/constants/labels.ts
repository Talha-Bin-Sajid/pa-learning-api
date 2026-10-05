import type { CcPolicy, OverdueFrequency, ReportingAccess, UserRole } from '../../domain/enums.js';

export const ROLE_LABELS: Record<UserRole, string> = {
  learning_team: 'Learning Team',
  hr: 'HR Team',
  manager: 'Manager',
  team_member: 'Team Member',
};

export const REPORTING_ACCESS_LABELS: Record<ReportingAccess, string> = {
  full: 'Full reporting - all staff',
  self: 'Own learning reports only',
};

export const OVERDUE_FREQUENCY_LABELS: Record<OverdueFrequency, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  fortnightly: 'Every fortnight',
};

export const CC_POLICY_LABELS: Record<CcPolicy, string> = {
  never: 'Never',
  overdue: 'Only when overdue',
  always: 'On every reminder',
};
