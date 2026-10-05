import type { IsoDate } from '../../shared/utils/dates.js';
import type { CcPolicy, OverdueFrequency, ReminderKind } from '../enums.js';

/** Firm-wide reminder configuration (single row: reminder_settings). */
export interface ReminderSettings {
  autoEnabled: boolean;
  leadDays: number[];
  overdueFrequency: OverdueFrequency;
  /** Local send time, 'HH:MM'. */
  sendTime: string;
  timezone: string;
  ccLineManager: CcPolicy;
  updatedAt: Date;
}

export type ReminderSettingsChanges = Partial<Pick<ReminderSettings, 'autoEnabled' | 'leadDays' | 'overdueFrequency' | 'sendTime' | 'ccLineManager'>>;

/** One reminder email (table: reminder_log). */
export interface ReminderLogEntry {
  id: string;
  recipientId: string;
  kind: ReminderKind;
  runDate: IsoDate;
  outstandingCount: number;
  overdueCount: number;
  triggers: string[];
  message: string | null;
  ccEmails: string[];
  sentBy: string | null;
  deliveryStatus: 'sent' | 'failed';
  error: string | null;
  sentAt: Date;
}

export type NewReminderLogEntry = Omit<ReminderLogEntry, 'id' | 'sentAt' | 'deliveryStatus' | 'error'> & {
  deliveryStatus?: 'sent' | 'failed';
  error?: string | null;
};
