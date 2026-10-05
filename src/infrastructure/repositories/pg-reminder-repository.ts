import type {
  NewReminderLogEntry,
  ReminderLogEntry,
  ReminderSettings,
  ReminderSettingsChanges,
} from '../../domain/entities/reminder.js';
import type { ReminderRepository } from '../../domain/repositories/reminder-repository.js';
import type { SqlExecutor } from '../database/database.js';

interface SettingsRow {
  auto_enabled: boolean;
  lead_days: number[];
  overdue_frequency: ReminderSettings['overdueFrequency'];
  send_time: string;
  timezone: string;
  cc_line_manager: ReminderSettings['ccLineManager'];
  updated_at: Date;
}

interface LogRow {
  id: string;
  recipient_id: string;
  kind: ReminderLogEntry['kind'];
  run_date: string;
  outstanding_count: number;
  overdue_count: number;
  triggers: string[];
  message: string | null;
  cc_emails: string[];
  sent_by: string | null;
  delivery_status: ReminderLogEntry['deliveryStatus'];
  error: string | null;
  sent_at: Date;
}

const toSettings = (r: SettingsRow): ReminderSettings => ({
  autoEnabled: r.auto_enabled,
  leadDays: [...r.lead_days].sort((a, b) => b - a),
  overdueFrequency: r.overdue_frequency,
  sendTime: r.send_time.slice(0, 5),
  timezone: r.timezone,
  ccLineManager: r.cc_line_manager,
  updatedAt: r.updated_at,
});

const toLog = (r: LogRow): ReminderLogEntry => ({
  id: r.id,
  recipientId: r.recipient_id,
  kind: r.kind,
  runDate: r.run_date,
  outstandingCount: r.outstanding_count,
  overdueCount: r.overdue_count,
  triggers: r.triggers,
  message: r.message,
  ccEmails: r.cc_emails,
  sentBy: r.sent_by,
  deliveryStatus: r.delivery_status,
  error: r.error,
  sentAt: r.sent_at,
});

const SETTINGS_COLUMNS = 'auto_enabled, lead_days, overdue_frequency, send_time::text as send_time, timezone, cc_line_manager, updated_at';
const LOG_COLUMNS = `id, recipient_id, kind, run_date, outstanding_count, overdue_count, triggers, message, cc_emails, sent_by,
  delivery_status, error, sent_at`;

export class PgReminderRepository implements ReminderRepository {
  constructor(private readonly db: SqlExecutor) {}

  async getSettings(): Promise<ReminderSettings> {
    const res = await this.db.query<SettingsRow>(`select ${SETTINGS_COLUMNS} from reminder_settings where id = 1`);
    return toSettings(res.rows[0]!);
  }

  async updateSettings(c: ReminderSettingsChanges, updatedBy: string): Promise<ReminderSettings> {
    const res = await this.db.query<SettingsRow>(
      `update reminder_settings set
         auto_enabled = coalesce($1, auto_enabled),
         lead_days = coalesce($2::smallint[], lead_days),
         overdue_frequency = coalesce($3::overdue_frequency, overdue_frequency),
         send_time = coalesce($4::time, send_time),
         cc_line_manager = coalesce($5::cc_policy, cc_line_manager),
         updated_by = $6
       where id = 1 returning ${SETTINGS_COLUMNS}`,
      [c.autoEnabled ?? null, c.leadDays ?? null, c.overdueFrequency ?? null, c.sendTime ?? null, c.ccLineManager ?? null, updatedBy],
    );
    return toSettings(res.rows[0]!);
  }

  async log(e: NewReminderLogEntry): Promise<ReminderLogEntry | null> {
    const res = await this.db.query<LogRow>(
      `insert into reminder_log (recipient_id, kind, run_date, outstanding_count, overdue_count, triggers, message, cc_emails,
         sent_by, delivery_status, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (recipient_id, run_date) where kind = 'automatic' do nothing
       returning ${LOG_COLUMNS}`,
      [
        e.recipientId,
        e.kind,
        e.runDate,
        e.outstandingCount,
        e.overdueCount,
        e.triggers,
        e.message,
        e.ccEmails,
        e.sentBy,
        e.deliveryStatus ?? 'sent',
        e.error ?? null,
      ],
    );
    return res.rows[0] ? toLog(res.rows[0]) : null;
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.query(`update reminder_log set delivery_status = 'failed', error = $2 where id = $1`, [id, error.slice(0, 500)]);
  }

  async claimOnce(key: string): Promise<boolean> {
    const res = await this.db.query('insert into notification_log (key) values ($1) on conflict (key) do nothing returning key', [key]);
    return res.rows.length > 0;
  }

  async listLog(limit: number): Promise<ReminderLogEntry[]> {
    const res = await this.db.query<LogRow>(`select ${LOG_COLUMNS} from reminder_log order by sent_at desc limit $1`, [limit]);
    return res.rows.map(toLog);
  }
}
