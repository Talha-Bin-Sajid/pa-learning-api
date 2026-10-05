import { daysBetween, todayIn, type IsoDate } from '../../shared/utils/dates.js';
import type { ReminderSettings } from '../entities/reminder.js';
import type { OverdueFrequency } from '../enums.js';
import type { Learner, LearningPlan, PlanEntry } from './learning-progress.js';

/**
 * Decides who gets an automatic reminder today (business rule 7):
 *  - an outstanding item due in exactly N days, for N in the configured lead days;
 *  - an overdue item on day 1 of being overdue and then every 1 / 7 / 14 days;
 *  - evidence rejected by the Learning Team the day before (so they re-upload promptly).
 * Items whose evidence is only "under review" count as completed and are never chased.
 * One aggregated email per person; CC the line manager per policy.
 */

export interface ReminderPlan<P extends Learner = Learner> {
  person: P;
  /** Why this person is being reminded today, e.g. ['due_in_14', 'overdue']. */
  triggers: string[];
  /** Everything outstanding (the email lists all of it, not just the triggering items). */
  outstanding: PlanEntry[];
  overdueCount: number;
  ccLineManager: boolean;
}

const OVERDUE_EVERY: Record<OverdueFrequency, number> = { daily: 1, weekly: 7, fortnightly: 14 };

/** Day context for date-based triggers (rejections). */
export interface ReminderDay {
  today: IsoDate;
  timeZone: string;
}

export function triggersFor(
  entries: PlanEntry[],
  settings: Pick<ReminderSettings, 'leadDays' | 'overdueFrequency'>,
  day?: ReminderDay,
): string[] {
  const triggers = new Set<string>();
  const every = OVERDUE_EVERY[settings.overdueFrequency];
  for (const e of entries) {
    if (day && e.rejected?.reviewedAt && daysBetween(todayIn(day.timeZone, e.rejected.reviewedAt), day.today) === 1) {
      triggers.add('evidence_rejected');
    }
    if (e.status === 'completed' || e.daysUntilDue === null) continue;
    if (e.status === 'outstanding' && settings.leadDays.includes(e.daysUntilDue)) triggers.add(`due_in_${e.daysUntilDue}`);
    if (e.status === 'overdue' && (e.daysOverdue - 1) % every === 0) triggers.add('overdue');
  }
  return [...triggers].sort();
}

export function shouldCcManager(policy: ReminderSettings['ccLineManager'], overdueCount: number): boolean {
  return policy === 'always' || (policy === 'overdue' && overdueCount > 0);
}

export function planAutomaticReminders<P extends Learner>(
  plans: LearningPlan<P>[],
  settings: ReminderSettings,
  today?: IsoDate,
): ReminderPlan<P>[] {
  if (!settings.autoEnabled) return [];
  const day = today ? { today, timeZone: settings.timezone } : undefined;
  const result: ReminderPlan<P>[] = [];
  for (const plan of plans) {
    const triggers = triggersFor(plan.entries, settings, day);
    if (triggers.length === 0) continue;
    const outstanding = plan.entries.filter((e) => e.status !== 'completed');
    const overdueCount = outstanding.filter((e) => e.status === 'overdue').length;
    result.push({ person: plan.person, triggers, outstanding, overdueCount, ccLineManager: shouldCcManager(settings.ccLineManager, overdueCount) });
  }
  return result;
}
