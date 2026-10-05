import type { Person } from '../../domain/entities/person.js';
import { can, canViewPerson, visibilityScope, type Actor } from '../../domain/services/access-policy.js';
import { summarise, type ProgressSummary } from '../../domain/services/learning-progress.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors/app-errors.js';
import { toCycleDto, type CycleDto } from '../dto/cycle.dto.js';
import { toLearningItemDto, toPlanEntryDto, type LearningItemDto, type PlanEntryDto } from '../dto/learning-item.dto.js';
import { toPersonDto, type PersonDto } from '../dto/person.dto.js';
import { awaitingReview, REVIEW_NUDGE_DAYS, waitingTooLong } from '../services/review-queue.js';
import { visibleLearners, type ProgressSnapshot, type ProgressSnapshotLoader } from '../services/progress-snapshot.js';

export interface MemberProgressDto {
  person: PersonDto;
  summary: ProgressSummary;
}

export interface ItemProgressDto {
  item: LearningItemDto;
  assignedCount: number;
  completedCount: number;
  /** Completions whose evidence is confirmed. */
  confirmedCount: number;
  overdueCount: number;
}

export interface OutstandingDto {
  personId: string;
  personName: string;
  itemId: string;
  title: string;
  dueDate: string | null;
  hours: number;
  isMandatory: boolean;
  overdue: boolean;
}

export interface EvidenceEventDto {
  completionId: string;
  personId: string;
  personName: string;
  itemId: string;
  title: string;
  hours: number;
  completedOn: string;
  fileName: string | null;
  reflection: string | null;
}

export interface OverviewDto {
  cycle: CycleDto;
  today: string;
  scope: 'all' | 'team';
  kpis: {
    itemCount: number;
    mandatoryItemCount: number;
    templateHours: number;
    memberCount: number;
    averageCompletionPct: number;
    evidenceCount: number;
    hoursLogged: number;
    outstandingCount: number;
    overdueCount: number;
    /** Completed items with confirmed evidence / still under review (team totals). */
    confirmedCount: number;
    underReviewCount: number;
    hoursConfirmed: number;
    averageConfirmedPct: number;
  };
  /** Evidence waiting for the Learning Team (flagged or not yet checked), in the actor's scope. */
  reviewQueue: { waiting: number; waitingOverDays: number; overDays: number };
  members: MemberProgressDto[];
  items: ItemProgressDto[];
  outstanding: OutstandingDto[];
  evidence: EvidenceEventDto[];
  /** Completions per month of the cycle year: [{ month: '2026-01', count }]. */
  evidenceByMonth: { month: string; count: number }[];
}

export interface PlanDto {
  cycle: CycleDto;
  today: string;
  person: PersonDto;
  summary: ProgressSummary;
  entries: PlanEntryDto[];
  /** Completed hours per category (for "CPD hours by category"). */
  hoursByCategory: { category: string; hours: number }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function reviewQueue(snap: ProgressSnapshot, include: (personId: string) => boolean): OverviewDto['reviewQueue'] {
  const waiting = awaitingReview(snap, include);
  return { waiting: waiting.length, waitingOverDays: waitingTooLong(waiting, snap.today).length, overDays: REVIEW_NUDGE_DAYS };
}

export class ProgressService {
  constructor(private readonly snapshots: ProgressSnapshotLoader) {}

  /** Dashboard data for the actor's visible team (scope all or team). */
  async overview(actor: Actor, cycleId?: string): Promise<OverviewDto> {
    if (!can(actor, 'viewTeam')) throw new ForbiddenError();
    const snap = await this.snapshots.load(cycleId);
    const learners = visibleLearners(actor, snap);
    const learnerIds = new Set(learners.map((p) => p.id));
    const plans = learners.map((p) => snap.progress.planFor(p));
    const itemCtx = { lookups: snap.lookups, peopleById: snap.peopleById };
    const activeItems = snap.items.filter((i) => !i.archivedAt);

    const members = plans.map((pl) => ({ person: toPersonDto(pl.person, snap.dtoContext), summary: pl.summary }));

    const items: ItemProgressDto[] = activeItems.map((item) => {
      const assignees = snap.progress.assigneesOf(item, learners);
      let completedCount = 0;
      let confirmedCount = 0;
      let overdueCount = 0;
      for (const p of assignees) {
        const e = snap.progress.entryFor(p.id, item);
        if (e.status === 'completed') {
          completedCount++;
          if (e.confirmed) confirmedCount++;
        } else if (e.status === 'overdue') overdueCount++;
      }
      return { item: toLearningItemDto(item, itemCtx), assignedCount: assignees.length, completedCount, confirmedCount, overdueCount };
    });

    const outstanding: OutstandingDto[] = plans.flatMap((pl) =>
      pl.entries
        .filter((e) => e.status !== 'completed')
        .map((e) => ({
          personId: pl.person.id,
          personName: pl.person.fullName,
          itemId: e.item.id,
          title: e.item.title,
          dueDate: e.item.dueDate,
          hours: e.item.hours,
          isMandatory: e.item.isMandatory,
          overdue: e.status === 'overdue',
        })),
    );

    const evidence = this.evidenceEvents(snap, (personId) => learnerIds.has(personId));
    const all = summarise(plans.flatMap((p) => p.entries));
    const year = snap.cycle.year;

    return {
      cycle: toCycleDto(snap.cycle),
      today: snap.today,
      scope: visibilityScope(actor) === 'all' ? 'all' : 'team',
      kpis: {
        itemCount: activeItems.length,
        mandatoryItemCount: activeItems.filter((i) => i.isMandatory).length,
        templateHours: round1(activeItems.reduce((a, i) => a + i.hours, 0)),
        memberCount: learners.length,
        averageCompletionPct: plans.length ? round1(plans.reduce((a, p) => a + p.summary.completionPct, 0) / plans.length) : 0,
        evidenceCount: evidence.length,
        hoursLogged: all.hoursCompleted,
        outstandingCount: all.outstanding,
        overdueCount: all.overdue,
        confirmedCount: all.confirmed,
        underReviewCount: all.underReview,
        hoursConfirmed: all.hoursConfirmed,
        averageConfirmedPct: plans.length ? round1(plans.reduce((a, p) => a + p.summary.confirmedPct, 0) / plans.length) : 0,
      },
      reviewQueue: reviewQueue(snap, (personId) => learnerIds.has(personId)),
      members,
      items,
      outstanding,
      evidence,
      evidenceByMonth: Array.from({ length: 12 }, (_, m) => {
        const month = `${year}-${String(m + 1).padStart(2, '0')}`;
        return { month, count: evidence.filter((e) => e.completedOn.startsWith(month)).length };
      }),
    };
  }

  /** Team Progress list. */
  async members(actor: Actor, cycleId?: string): Promise<MemberProgressDto[]> {
    if (!can(actor, 'viewTeam')) throw new ForbiddenError();
    const snap = await this.snapshots.load(cycleId);
    return visibleLearners(actor, snap).map((p) => ({
      person: toPersonDto(p, snap.dtoContext),
      summary: snap.progress.planFor(p).summary,
    }));
  }

  /** One person's plan, if the actor may see them (managers: direct reports only). */
  async member(actor: Actor, profileId: string, cycleId?: string): Promise<PlanDto> {
    const snap = await this.snapshots.load(cycleId);
    const person = snap.peopleById.get(profileId);
    if (!person || !canViewPerson(actor, person)) throw new NotFoundError('person');
    return this.plan(snap, person, can(actor, 'reviewEvidence'));
  }

  /** My Learning Plan / My Dashboard. */
  async myPlan(actor: Person, cycleId?: string): Promise<PlanDto> {
    return this.plan(await this.snapshots.load(cycleId), actor, can(actor, 'reviewEvidence'));
  }

  private plan(snap: ProgressSnapshot, person: Person, detailedChecks: boolean): PlanDto {
    const plan = snap.progress.planFor(person);
    const itemCtx = { lookups: snap.lookups, peopleById: snap.peopleById, checks: snap.checks, detailedChecks };
    const byCategory = new Map<string, number>();
    for (const e of plan.entries) {
      if (e.status !== 'completed') continue;
      const name = snap.lookups.categories.find((c) => c.id === e.item.categoryId)?.name ?? 'Other';
      byCategory.set(name, (byCategory.get(name) ?? 0) + e.item.hours);
    }
    return {
      cycle: toCycleDto(snap.cycle),
      today: snap.today,
      person: toPersonDto(person, snap.dtoContext),
      summary: plan.summary,
      entries: plan.entries.map((e) => toPlanEntryDto(e, itemCtx)),
      hoursByCategory: [...byCategory].map(([category, hours]) => ({ category, hours: Math.round(hours * 100) / 100 })),
    };
  }

  private evidenceEvents(snap: ProgressSnapshot, include: (personId: string) => boolean): EvidenceEventDto[] {
    return snap.completions.flatMap((c) => {
      const item = snap.itemsById.get(c.itemId);
      const person = snap.peopleById.get(c.profileId);
      if (!item || !person || !include(c.profileId)) return [];
      return [
        {
          completionId: c.id,
          personId: person.id,
          personName: person.fullName,
          itemId: item.id,
          title: item.title,
          hours: item.hours,
          completedOn: c.completedOn,
          fileName: c.evidence?.fileName ?? null,
          reflection: c.reflection,
        },
      ];
    });
  }
}
