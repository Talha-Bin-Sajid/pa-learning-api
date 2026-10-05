import { z } from 'zod';
import {
  CC_POLICIES,
  EVIDENCE_MODES,
  MY_REPORT_KINDS,
  OVERDUE_FREQUENCIES,
  PROFILE_STATUSES,
  REPORTING_ACCESS,
  TEAM_REPORT_KINDS,
  USER_ROLES,
} from '../../../domain/enums.js';
import { LIMITS } from '../../../shared/constants/limits.js';
import { isoDate, uuid } from './common.schemas.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

// ---------- shared query params ----------
export const cycleQuery = z.object({ cycleId: uuid.optional() });

export const periodQuery = z
  .object({ cycleId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to', path: ['from'] });

// ---------- learning items ----------
export const itemBody = z.object({
  cycleId: uuid.optional(),
  title: z.string().trim().min(1, 'Enter an activity title').max(LIMITS.titleMax),
  categoryId: z.number().int().positive(),
  cpdTypeId: z.number().int().positive(),
  deliveryTypeId: z.number().int().positive(),
  provider: optionalText(LIMITS.providerMax),
  hours: z.number().positive('Enter the hours').max(LIMITS.hoursMax),
  dueDate: isoDate.nullish().transform((v) => v ?? null),
  isMandatory: z.boolean(),
  evidenceMode: z.enum(EVIDENCE_MODES),
  link: z
    .string()
    .trim()
    .max(2048)
    .nullish()
    .transform((v) => v || null)
    .refine((v) => !v || /^https?:\/\//i.test(v), 'Link must start with http:// or https://'),
  description: optionalText(LIMITS.descriptionMax),
  audience: z.object({
    all: z.boolean(),
    designationIds: z.array(z.number().int().positive()).max(50).default([]),
    profileIds: z.array(uuid).max(1000).default([]),
  }),
});

export const itemListQuery = z.object({
  cycleId: uuid.optional(),
  includeArchived: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

const importRow = z.object({
  rowNumber: z.number().int().min(1),
  values: z.record(z.string().max(60), z.string().max(4000)),
});

export const itemImportBody = z.object({
  cycleId: uuid.optional(),
  rows: z.array(importRow).min(1).max(LIMITS.importMaxRows),
});

// ---------- people ----------
export const personBody = z.object({
  fullName: z.string().trim().min(1, 'Enter a full name').max(LIMITS.nameMax),
  email: z.email('Enter a valid email address').max(254),
  role: z.enum(USER_ROLES),
  designationId: z.number().int().positive().nullable(),
  reportingAccess: z.enum(REPORTING_ACCESS).optional(),
  lineManagerId: uuid.nullable(),
  status: z.enum(PROFILE_STATUSES).optional(),
});

export const personPatchBody = personBody.partial().refine((v) => Object.keys(v).length > 0, 'Provide at least one change');

export const peopleBulkBody = z.object({
  updates: z
    .array(personBody.partial().extend({ id: uuid }))
    .min(1)
    .max(500),
});

export const peopleListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(PROFILE_STATUSES).optional(),
});

export const userImportBody = z.object({ rows: z.array(importRow).min(1).max(LIMITS.importMaxRows) });

// ---------- completions ----------
/** Multipart fields arrive as strings. */
export const completionFields = z.object({
  completedOn: isoDate,
  reflection: optionalText(LIMITS.reflectionMax),
});

export const evidenceDecisionBody = z.object({
  decision: z.enum(['verified', 'rejected']),
  note: optionalText(1000),
});

export const itemIdParams = z.object({ itemId: uuid });
export const profileIdParams = z.object({ profileId: uuid });

export const evidenceRegisterQuery = z
  .object({ cycleId: uuid.optional(), profileId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to', path: ['from'] });

// ---------- reminders ----------
export const reminderSettingsBody = z
  .object({
    autoEnabled: z.boolean().optional(),
    leadDays: z.array(z.number().int().min(1).max(365)).max(10).optional(),
    overdueFrequency: z.enum(OVERDUE_FREQUENCIES).optional(),
    sendTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)')
      .optional(),
    ccLineManager: z.enum(CC_POLICIES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one change');

export const sendRemindersBody = z.object({
  profileIds: z.array(uuid).min(1, 'Select at least one person').max(200),
  message: optionalText(LIMITS.reminderMessageMax),
});

export const reminderLogQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

// ---------- reports ----------
export const teamReportParams = z.object({ kind: z.enum(TEAM_REPORT_KINDS) });
export const myReportParams = z.object({ kind: z.enum(MY_REPORT_KINDS) });
