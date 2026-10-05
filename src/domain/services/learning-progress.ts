import { daysBetween, type IsoDate } from '../../shared/utils/dates.js';
import type { Completion } from '../entities/completion.js';
import type { LearningItem } from '../entities/learning-item.js';
import type { ItemStatus } from '../enums.js';
import { audienceIncludes } from '../value-objects/audience.js';

/**
 * The heart of the platform (ADR 0002): who has to do what, and how far they are.
 *
 *   Assigned     ⇔ item not archived ∧ audience includes the person
 *   Completed    ⇔ a completion exists that was not rejected (optionally: dated inside a period)
 *   Confirmed    ⇔ completed ∧ (no file needed ∨ evidence verified by the AI or approved by a person)
 *                  (completed but not confirmed = "under review": counts for the person, shown separately in reports)
 *   Overdue      ⇔ assigned ∧ not completed ∧ due_date < today
 *   Completion % = completed hours ÷ assigned hours
 */

export interface Learner {
  id: string;
  designationId: number | null;
}

export interface PlanEntry {
  item: LearningItem;
  /** The completion that counts (null if none, or outside the requested period). */
  completion: Completion | null;
  /** A submission a reviewer rejected - the item is outstanding again until re-submitted. */
  rejected: Completion | null;
  status: ItemStatus;
  /** Completed and the evidence is confirmed (see isConfirmed). False when not completed. */
  confirmed: boolean;
  daysOverdue: number;
  /** Days until the due date for outstanding items (negative when overdue); null when completed or undated. */
  daysUntilDue: number | null;
}

export interface ProgressSummary {
  assigned: number;
  completed: number;
  outstanding: number;
  overdue: number;
  mandatoryAssigned: number;
  mandatoryCompleted: number;
  mandatoryOutstanding: number;
  hoursAssigned: number;
  hoursCompleted: number;
  hoursOutstanding: number;
  /** 0–100, hours-weighted. */
  completionPct: number;
  /** Completed items whose evidence is confirmed (verified / approved / no file needed). */
  confirmed: number;
  mandatoryConfirmed: number;
  hoursConfirmed: number;
  /** Completed but the evidence is still waiting for confirmation. */
  underReview: number;
  /** 0–100, hours-weighted, confirmed only. */
  confirmedPct: number;
}

export interface LearningPlan<P extends Learner = Learner> {
  person: P;
  entries: PlanEntry[];
  summary: ProgressSummary;
}

export interface Period {
  from?: IsoDate | null;
  to?: IsoDate | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function inPeriod(date: IsoDate, period?: Period): boolean {
  if (!period) return true;
  return (!period.from || date >= period.from) && (!period.to || date <= period.to);
}

/** Evidence confirmed: verified (AI or person), or a completion with no file to check (acknowledgement). */
export function isConfirmed(c: Completion): boolean {
  return c.reviewStatus === 'verified' || (!c.evidence && c.reviewStatus === 'not_reviewed');
}

export function isAssigned(item: LearningItem, person: Learner): boolean {
  return item.archivedAt === null && audienceIncludes(item.audience, person);
}

export function summarise(entries: PlanEntry[]): ProgressSummary {
  let hoursAssigned = 0;
  let hoursCompleted = 0;
  let hoursConfirmed = 0;
  const s = {
    assigned: 0,
    completed: 0,
    outstanding: 0,
    overdue: 0,
    mandatoryAssigned: 0,
    mandatoryCompleted: 0,
    mandatoryOutstanding: 0,
    confirmed: 0,
    mandatoryConfirmed: 0,
    underReview: 0,
  };
  for (const e of entries) {
    s.assigned++;
    hoursAssigned += e.item.hours;
    if (e.item.isMandatory) s.mandatoryAssigned++;
    if (e.status === 'completed') {
      s.completed++;
      hoursCompleted += e.item.hours;
      if (e.item.isMandatory) s.mandatoryCompleted++;
      if (e.confirmed) {
        s.confirmed++;
        hoursConfirmed += e.item.hours;
        if (e.item.isMandatory) s.mandatoryConfirmed++;
      } else s.underReview++;
    } else {
      s.outstanding++;
      if (e.status === 'overdue') s.overdue++;
      if (e.item.isMandatory) s.mandatoryOutstanding++;
    }
  }
  return {
    ...s,
    hoursAssigned: round2(hoursAssigned),
    hoursCompleted: round2(hoursCompleted),
    hoursOutstanding: round2(hoursAssigned - hoursCompleted),
    completionPct: hoursAssigned > 0 ? Math.min(100, round2((hoursCompleted / hoursAssigned) * 100)) : 0,
    hoursConfirmed: round2(hoursConfirmed),
    confirmedPct: hoursAssigned > 0 ? Math.min(100, round2((hoursConfirmed / hoursAssigned) * 100)) : 0,
  };
}

export class LearningProgress {
  private readonly completionIndex = new Map<string, Completion>();
  private readonly activeItems: LearningItem[];

  constructor(
    items: LearningItem[],
    completions: Completion[],
    readonly today: IsoDate,
  ) {
    this.activeItems = items.filter((i) => i.archivedAt === null);
    for (const c of completions) this.completionIndex.set(`${c.profileId}:${c.itemId}`, c);
  }

  completionOf(personId: string, itemId: string): Completion | null {
    return this.completionIndex.get(`${personId}:${itemId}`) ?? null;
  }

  /** Items assigned to the person, ordered by due date (undated last), then title. */
  assignedItems(person: Learner): LearningItem[] {
    return this.activeItems
      .filter((i) => audienceIncludes(i.audience, person))
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.title.localeCompare(b.title));
  }

  /** People (from `people`) to whom the item is assigned. */
  assigneesOf<P extends Learner>(item: LearningItem, people: P[]): P[] {
    return item.archivedAt === null ? people.filter((p) => audienceIncludes(item.audience, p)) : [];
  }

  /**
   * A person's learning plan. With `period`, only completions dated inside it
   * count as completed (used by "completed in period" reports).
   */
  planFor<P extends Learner>(person: P, period?: Period): LearningPlan<P> {
    const entries = this.assignedItems(person).map((item) => this.entryFor(person.id, item, period));
    return { person, entries, summary: summarise(entries) };
  }

  entryFor(personId: string, item: LearningItem, period?: Period): PlanEntry {
    const raw = this.completionOf(personId, item.id);
    const rejected = raw?.reviewStatus === 'rejected' ? raw : null;
    const completion = raw && !rejected && inPeriod(raw.completedOn, period) ? raw : null;
    if (completion) {
      return { item, completion, rejected: null, status: 'completed', confirmed: isConfirmed(completion), daysOverdue: 0, daysUntilDue: null };
    }
    const daysUntilDue = item.dueDate ? daysBetween(this.today, item.dueDate) : null;
    const overdue = daysUntilDue !== null && daysUntilDue < 0;
    return {
      item,
      completion: null,
      rejected,
      confirmed: false,
      status: overdue ? 'overdue' : 'outstanding',
      daysOverdue: overdue ? -daysUntilDue : 0,
      daysUntilDue,
    };
  }
}
