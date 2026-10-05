import type { ReportingAccess, UserRole } from '../enums.js';

/**
 * Default reporting access (business rule 4): full for the Learning Team, HR,
 * and Director/Partner-level designations; own reports otherwise.
 */
export function defaultReportingAccess(role: UserRole, designationGrantsFullAccess: boolean): ReportingAccess {
  return role === 'learning_team' || role === 'hr' || designationGrantsFullAccess ? 'full' : 'self';
}
