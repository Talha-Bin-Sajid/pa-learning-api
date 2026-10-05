import type { ReminderRepository } from '../../domain/repositories/reminder-repository.js';
import type { Logger } from '../../shared/utils/logger.js';
import { todayIn } from '../../shared/utils/dates.js';

/** Local wall-clock time 'HH:MM' in a time zone. */
export function localTime(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/**
 * Minimal in-process scheduler (no cron dependency). Every minute it checks
 * whether the configured send time has passed today (in the firm's time zone)
 * and, if so, runs the automatic reminders once. Restarts are safe: the
 * reminder log's unique (person, day) index prevents duplicate emails.
 */
export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastRunDate: string | null = null;
  private running = false;

  constructor(
    private readonly reminders: ReminderRepository,
    private readonly run: () => Promise<unknown>,
    private readonly logger: Logger,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    this.logger.info('reminder scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests. */
  async tick(now: Date = new Date()): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const settings = await this.reminders.getSettings();
      if (!settings.autoEnabled) return false;
      const today = todayIn(settings.timezone, now);
      if (this.lastRunDate === today || localTime(settings.timezone, now) < settings.sendTime) return false;
      this.lastRunDate = today;
      await this.run();
      return true;
    } catch (err) {
      this.logger.error('automatic reminder run failed', { err });
      return false;
    } finally {
      this.running = false;
    }
  }
}
