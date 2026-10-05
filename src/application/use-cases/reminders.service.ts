import type { ReminderSettings, ReminderSettingsChanges } from '../../domain/entities/reminder.js';
import type { Person } from '../../domain/entities/person.js';
import type { AuditLog } from '../../domain/repositories/audit-log.js';
import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import type { ReminderRepository } from '../../domain/repositories/reminder-repository.js';
import { can, type Actor } from '../../domain/services/access-policy.js';
import type { PlanEntry } from '../../domain/services/learning-progress.js';
import { planAutomaticReminders, shouldCcManager } from '../../domain/services/reminder-planner.js';
import { BusinessRuleError, ForbiddenError, ValidationError } from '../../shared/errors/app-errors.js';
import type { Logger } from '../../shared/utils/logger.js';
import { toPersonDto, type PersonDto } from '../dto/person.dto.js';
import type { EmailSender } from '../ports/email-sender.js';
import { composeReminderEmail, composeReviewDigestEmail } from '../services/reminder-email.js';
import { visibleLearners, type ProgressSnapshot, type ProgressSnapshotLoader } from '../services/progress-snapshot.js';
import { awaitingReview, REVIEW_NUDGE_DAYS, waitingTooLong } from '../services/review-queue.js';
import { daysBetween } from '../../shared/utils/dates.js';

export interface ReminderCandidateDto {
  person: PersonDto;
  outstandingCount: number;
  overdueCount: number;
}

export interface ReminderLogDto {
  id: string;
  kind: 'automatic' | 'manual';
  sentAt: string;
  recipient: { id: string; fullName: string; email: string };
  outstandingCount: number;
  overdueCount: number;
  triggers: string[];
  hasNote: boolean;
  ccEmails: string[];
  sentBy: string | null;
  deliveryStatus: 'sent' | 'failed';
}

export interface SendResult {
  sent: number;
  failed: number;
  skipped: number;
}

const MAX_MANUAL_RECIPIENTS = 200;
/** Day the Learning Team review digest goes out (0 = Sunday … 1 = Monday). */
const DIGEST_WEEKDAY = 1;

export class RemindersService {
  constructor(
    private readonly reminders: ReminderRepository,
    private readonly people: PersonRepository,
    private readonly snapshots: ProgressSnapshotLoader,
    private readonly email: EmailSender,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly appUrl: string,
  ) {}

  async settings(actor: Actor): Promise<ReminderSettings> {
    this.assertCanManage(actor);
    return this.reminders.getSettings();
  }

  async updateSettings(actor: Actor, changes: ReminderSettingsChanges): Promise<ReminderSettings> {
    this.assertCanManage(actor);
    if (changes.leadDays) changes.leadDays = [...new Set(changes.leadDays)].sort((a, b) => b - a);
    const saved = await this.reminders.updateSettings(changes, actor.id);
    await this.audit.record({ actorId: actor.id, action: 'reminders.settings_updated', entityType: 'reminder_settings', entityId: '1', metadata: { ...changes } });
    return saved;
  }

  /** People with something outstanding in the current cycle. */
  async candidates(actor: Actor): Promise<ReminderCandidateDto[]> {
    this.assertCanManage(actor);
    const snap = await this.snapshots.load();
    return visibleLearners(actor, snap)
      .map((p) => ({ person: p, summary: snap.progress.planFor(p).summary }))
      .filter((x) => x.summary.outstanding > 0)
      .map((x) => ({ person: toPersonDto(x.person, snap.dtoContext), outstandingCount: x.summary.outstanding, overdueCount: x.summary.overdue }))
      .sort((a, b) => b.overdueCount - a.overdueCount || b.outstandingCount - a.outstandingCount);
  }

  /** "Send a reminder now". */
  async sendManual(actor: Actor, profileIds: string[], note?: string | null): Promise<SendResult> {
    this.assertCanManage(actor);
    const ids = [...new Set(profileIds)];
    if (ids.length === 0) throw new ValidationError('Select at least one person to remind.', [{ path: 'profileIds', message: 'Empty' }]);
    if (ids.length > MAX_MANUAL_RECIPIENTS) throw new ValidationError(`Send to at most ${MAX_MANUAL_RECIPIENTS} people at once.`);

    const [snap, settings] = await Promise.all([this.snapshots.load(), this.reminders.getSettings()]);
    const result: SendResult = { sent: 0, failed: 0, skipped: 0 };
    for (const id of ids) {
      const person = snap.peopleById.get(id);
      if (!person || person.status !== 'active') {
        result.skipped++;
        continue;
      }
      const outstanding = snap.progress.planFor(person).entries.filter((e) => e.status !== 'completed');
      if (outstanding.length === 0) {
        result.skipped++;
        continue;
      }
      const overdueCount = outstanding.filter((e) => e.status === 'overdue').length;
      const cc = shouldCcManager(settings.ccLineManager, overdueCount) ? this.managerEmail(person, snap.peopleById) : [];
      const ok = await this.deliver(person, outstanding, cc, {
        kind: 'manual',
        runDate: snap.today,
        triggers: ['manual'],
        message: note?.trim() || null,
        sentBy: actor.id,
      });
      if (ok === null) result.skipped++;
      else if (ok) result.sent++;
      else result.failed++;
    }
    await this.audit.record({ actorId: actor.id, action: 'reminders.sent_manual', entityType: 'reminder_log', metadata: { ...result } });
    return result;
  }

  async log(actor: Actor, limit = 50): Promise<ReminderLogDto[]> {
    this.assertCanManage(actor);
    const [entries, everyone] = await Promise.all([this.reminders.listLog(Math.min(Math.max(limit, 1), 200)), this.people.list()]);
    const byId = new Map(everyone.map((p) => [p.id, p]));
    return entries.map((e) => {
      const r = byId.get(e.recipientId);
      return {
        id: e.id,
        kind: e.kind,
        sentAt: e.sentAt.toISOString(),
        recipient: { id: e.recipientId, fullName: r?.fullName ?? 'Former member', email: r?.email ?? '' },
        outstandingCount: e.outstandingCount,
        overdueCount: e.overdueCount,
        triggers: e.triggers,
        hasNote: !!e.message,
        ccEmails: e.ccEmails,
        sentBy: e.sentBy ? (byId.get(e.sentBy)?.fullName ?? null) : null,
        deliveryStatus: e.deliveryStatus,
      };
    });
  }

  /**
   * The daily automatic run (called by the scheduler). Safe to call repeatedly:
   * the log's unique (person, day) constraint guarantees at most one email per person per day.
   */
  async runAutomatic(): Promise<SendResult> {
    const settings = await this.reminders.getSettings();
    const result: SendResult = { sent: 0, failed: 0, skipped: 0 };
    if (!settings.autoEnabled) return result;

    let snap;
    try {
      snap = await this.snapshots.load();
    } catch (err) {
      if (err instanceof BusinessRuleError) return result; // no current cycle
      throw err;
    }
    const plans = snap.activePeople.map((p) => snap.progress.planFor(p));
    for (const r of planAutomaticReminders(plans, settings, snap.today)) {
      const cc = r.ccLineManager ? this.managerEmail(r.person, snap.peopleById) : [];
      const ok = await this.deliver(r.person, r.outstanding, cc, {
        kind: 'automatic',
        runDate: snap.today,
        triggers: r.triggers,
        message: null,
        sentBy: null,
      });
      if (ok === null) result.skipped++;
      else if (ok) result.sent++;
      else result.failed++;
    }
    this.logger.info('automatic reminders run', { ...result, date: snap.today });
    await this.sendReviewDigest(snap).catch((err: unknown) => this.logger.error('review digest failed', { err }));
    return result;
  }

  /**
   * Weekly (Mondays) email to the Learning Team when evidence has waited more
   * than REVIEW_NUDGE_DAYS days for a decision. At most once per day (claimOnce).
   * Returns how many emails were sent.
   */
  async sendReviewDigest(snap: ProgressSnapshot): Promise<number> {
    if (new Date(`${snap.today}T00:00:00Z`).getUTCDay() !== DIGEST_WEEKDAY) return 0;
    const waiting = awaitingReview(snap);
    const stale = waitingTooLong(waiting, snap.today).sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
    const team = snap.activePeople.filter((p) => p.role === 'learning_team');
    if (stale.length === 0 || team.length === 0) return 0;
    if (!(await this.reminders.claimOnce(`review-digest:${snap.today}`))) return 0;

    const items = stale.map((c) => ({
      personName: snap.peopleById.get(c.profileId)?.fullName ?? 'Former member',
      title: snap.itemsById.get(c.itemId)?.title ?? 'Learning item',
      daysWaiting: daysBetween(c.submittedAt.toISOString().slice(0, 10), snap.today),
      reason: c.reviewNotes,
    }));
    let sent = 0;
    for (const member of team) {
      try {
        await this.email.send(
          composeReviewDigestEmail({
            to: member.email,
            firstName: member.fullName.split(/\s+/)[0] ?? member.fullName,
            waiting: waiting.length,
            stale: items,
            overDays: REVIEW_NUDGE_DAYS,
            appUrl: this.appUrl,
          }),
        );
        sent++;
      } catch (err) {
        this.logger.error('review digest email failed', { recipientId: member.id, err });
      }
    }
    await this.audit.record({ actorId: null, action: 'evidence.review_digest', entityType: 'notification', metadata: { stale: stale.length, sent } });
    return sent;
  }

  /** Logs first (idempotency guard), then sends. Returns null if already sent today (automatic only). */
  private async deliver(
    person: Person,
    outstanding: PlanEntry[],
    cc: string[],
    meta: { kind: 'automatic' | 'manual'; runDate: string; triggers: string[]; message: string | null; sentBy: string | null },
  ): Promise<boolean | null> {
    const entry = await this.reminders.log({
      recipientId: person.id,
      kind: meta.kind,
      runDate: meta.runDate,
      outstandingCount: outstanding.length,
      overdueCount: outstanding.filter((e) => e.status === 'overdue').length,
      triggers: meta.triggers,
      message: meta.message,
      ccEmails: cc,
      sentBy: meta.sentBy,
    });
    if (!entry) return null;
    try {
      await this.email.send(
        composeReminderEmail({
          to: person.email,
          cc,
          firstName: person.fullName.split(/\s+/)[0] ?? person.fullName,
          outstanding,
          appUrl: this.appUrl,
          note: meta.message,
        }),
      );
      return true;
    } catch (err) {
      this.logger.error('reminder email failed', { recipientId: person.id, err });
      await this.reminders.markFailed(entry.id, err instanceof Error ? err.message : 'send failed');
      return false;
    }
  }

  private managerEmail(person: Person, peopleById: Map<string, Person>): string[] {
    const m = person.lineManagerId ? peopleById.get(person.lineManagerId) : undefined;
    return m && m.status === 'active' ? [m.email] : [];
  }

  private assertCanManage(actor: Actor): void {
    if (!can(actor, 'manageReminders')) throw new ForbiddenError('Only the Learning Team can manage reminders.');
  }
}
