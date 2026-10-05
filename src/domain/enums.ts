/**
 * Domain enumerations. Values mirror the Postgres enums in
 * backend/supabase/migrations/20261004000100_init_schema.sql - keep them in sync.
 */

export const USER_ROLES = ['learning_team', 'hr', 'manager', 'team_member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const REPORTING_ACCESS = ['full', 'self'] as const;
export type ReportingAccess = (typeof REPORTING_ACCESS)[number];

export const PROFILE_STATUSES = ['active', 'pending', 'inactive'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const EVIDENCE_MODES = ['certificate', 'acknowledgement'] as const;
export type EvidenceMode = (typeof EVIDENCE_MODES)[number];

export const REVIEW_STATUSES = ['not_reviewed', 'verified', 'flagged', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const OVERDUE_FREQUENCIES = ['daily', 'weekly', 'fortnightly'] as const;
export type OverdueFrequency = (typeof OVERDUE_FREQUENCIES)[number];

export const CC_POLICIES = ['never', 'overdue', 'always'] as const;
export type CcPolicy = (typeof CC_POLICIES)[number];

export const REMINDER_KINDS = ['automatic', 'manual'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** Who a person may see. Derived from role + reporting access (never stored). */
export const VISIBILITY_SCOPES = ['all', 'team', 'self'] as const;
export type VisibilityScope = (typeof VISIBILITY_SCOPES)[number];

/** Status of one item in one person's learning plan (derived). */
export const ITEM_STATUSES = ['completed', 'overdue', 'outstanding'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const TEAM_REPORT_KINDS = [
  'log',
  'completion',
  'mandatory',
  'outstanding',
  'evidence',
  'icaew',
  'acca',
] as const;
export type TeamReportKind = (typeof TEAM_REPORT_KINDS)[number];

export const MY_REPORT_KINDS = ['all', 'period', 'outstanding'] as const;
export type MyReportKind = (typeof MY_REPORT_KINDS)[number];
