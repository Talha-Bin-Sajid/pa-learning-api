import type { NewReminderLogEntry, ReminderLogEntry, ReminderSettings, ReminderSettingsChanges } from '../entities/reminder.js';

export interface ReminderRepository {
  getSettings(): Promise<ReminderSettings>;
  updateSettings(changes: ReminderSettingsChanges, updatedBy: string): Promise<ReminderSettings>;
  /**
   * Records a reminder. For automatic reminders returns null if one was already
   * logged for that person today (the idempotency guard for the scheduler).
   */
  log(entry: NewReminderLogEntry): Promise<ReminderLogEntry | null>;
  markFailed(id: string, error: string): Promise<void>;
  listLog(limit: number): Promise<ReminderLogEntry[]>;
  /** Claims a one-off notification key. False if it was already claimed (already sent). */
  claimOnce(key: string): Promise<boolean>;
}
