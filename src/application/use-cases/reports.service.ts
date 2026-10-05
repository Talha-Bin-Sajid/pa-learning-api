import type { Person } from '../../domain/entities/person.js';
import type { MyReportKind, TeamReportKind } from '../../domain/enums.js';
import { can, type Actor } from '../../domain/services/access-policy.js';
import type { LearningPlan, Period, PlanEntry } from '../../domain/services/learning-progress.js';
import { ROLE_LABELS } from '../../shared/constants/labels.js';
import { ForbiddenError } from '../../shared/errors/app-errors.js';
import type { Cell, SheetSpec, WorkbookWriter } from '../ports/workbook.js';
import {
  visibleLearners,
  type ProgressSnapshot,
  type ProgressSnapshotLoader,
} from '../services/progress-snapshot.js';

export interface ReportFile {
  fileName: string;
  content: Buffer;
}

const TEAM_TITLES: Record<TeamReportKind, string> = {
  log: 'Full Learning Log',
  completion: 'Team Completion Report',
  mandatory: 'Mandatory Items Status',
  outstanding: 'Outstanding Learning',
  evidence: 'Evidence Register',
  icaew: 'ICAEW CPD Log',
  acca: 'ACCA CPD Log',
};

const MY_TITLES: Record<MyReportKind, string> = {
  all: 'Full completion report',
  period: 'Completed in period',
  outstanding: 'Outstanding learning',
};

const n2 = (v: number) => Math.round(v * 100) / 100;
const statusLabel = (e: PlanEntry) =>
  e.status === 'completed' ? 'Completed' : e.status === 'overdue' ? 'Overdue' : 'Outstanding';
/** Whether the evidence behind a completion has been confirmed (verified / approved / no file needed). */
const evidenceLabel = (e: PlanEntry) =>
  e.status === 'completed' ? (e.confirmed ? 'Confirmed' : 'Under review') : e.rejected ? 'Rejected' : '';
const checkedBy = (e: PlanEntry) => {
  const c = e.completion ?? e.rejected;
  if (!c?.evidence) return c ? 'No file needed' : '';
  return c.reviewSource === 'manual' ? 'Learning Team' : c.reviewSource === 'ai' ? 'Automatic check' : 'Not yet';
};
const ukDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

export function periodLabel(period: Period): string {
  if (!period.from && !period.to) return 'Whole programme year';
  return `${period.from ? ukDate(period.from) : 'the start'} to ${period.to ? ukDate(period.to) : 'today'}`;
}

/** Excel exports. Team reports are scoped to the actor's visibility (managers: their team). */
export class ReportsService {
  constructor(
    private readonly snapshots: ProgressSnapshotLoader,
    private readonly writer: WorkbookWriter,
  ) {}

  async team(
    actor: Actor,
    kind: TeamReportKind,
    cycleId: string | undefined,
    period: Period,
  ): Promise<ReportFile> {
    if (!can(actor, 'viewTeam')) throw new ForbiddenError();
    const snap = await this.snapshots.load(cycleId);
    const learners = visibleLearners(actor, snap);
    const plans = learners.map((p) => snap.progress.planFor(p, period));
    const title = `Project Accountants - ${TEAM_TITLES[kind]} - ${snap.cycle.year}`;

    const sheets: SheetSpec[] = [this.summarySheet(title, period, plans, snap)];
    sheets.push(this.teamDetail(kind, plans, snap));

    return {
      fileName: `project-accountants-${kind}-report-${snap.cycle.year}.xlsx`,
      content: await this.writer.write(sheets, { title }),
    };
  }

  async mine(
    actor: Person,
    kind: MyReportKind,
    cycleId: string | undefined,
    period: Period,
  ): Promise<ReportFile> {
    const snap = await this.snapshots.load(cycleId);
    const full = snap.progress.planFor(actor);
    const scoped = snap.progress.planFor(actor, period);
    let entries = scoped.entries;
    if (kind === 'outstanding') entries = entries.filter((e) => e.status !== 'completed');
    if (kind === 'period') entries = entries.filter((e) => e.status === 'completed');

    const designation =
      actor.designationId != null ? snap.dtoContext.designations.get(actor.designationId)?.name : undefined;
    const byCategory = new Map<string, number>();
    for (const e of full.entries.filter((x) => x.status === 'completed')) {
      const c = this.name(snap, 'categories', e.item.categoryId);
      byCategory.set(c, (byCategory.get(c) ?? 0) + e.item.hours);
    }
    const s = full.summary;
    const cover: Cell[][] = [
      [`Project Accountants - CPD Record ${snap.cycle.year}`],
      [],
      ['Name', actor.fullName],
      ['Email', actor.email],
      ['Designation', designation ?? '-'],
      ['Report', MY_TITLES[kind]],
      ['Period', periodLabel(period)],
      ['Generated', snap.today],
      [],
      ['Items assigned', s.assigned],
      ['Items completed', s.completed],
      ['Hours required', s.hoursAssigned],
      ['Hours completed', s.hoursCompleted],
      ['Completion %', n2(s.completionPct)],
      [],
      ['CPD hours by category'],
      ...[...byCategory].map(([c, h]): Cell[] => [c, n2(h)]),
    ];
    const head = [
      'Activity',
      'Category',
      'CPD Type',
      'Delivery',
      'Provider',
      'Hours',
      'Due Date',
      'Mandatory',
      'Status',
      'Evidence',
      'Completed On',
      'Evidence File',
      'Reflection',
    ];
    const rows = entries.map((e) => [
      e.item.title,
      this.name(snap, 'categories', e.item.categoryId),
      this.name(snap, 'cpdTypes', e.item.cpdTypeId),
      this.name(snap, 'deliveryTypes', e.item.deliveryTypeId),
      e.item.provider,
      e.item.hours,
      e.item.dueDate,
      e.item.isMandatory ? 'Yes' : 'No',
      statusLabel(e),
      evidenceLabel(e),
      e.completion?.completedOn ?? null,
      e.completion?.evidence?.fileName ?? null,
      e.completion?.reflection ?? null,
    ]);

    const slug = actor.fullName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return {
      fileName: `${slug || 'my'}-cpd-${kind}-${snap.cycle.year}.xlsx`,
      content: await this.writer.write(
        [
          { name: 'CPD Record', rows: cover, columnWidths: [30, 44], titleRows: [0, 15] },
          {
            name: 'Activity',
            rows: [head, ...rows],
            headerRow: 0,
            columnWidths: [38, 24, 22, 20, 16, 8, 12, 11, 12, 14, 13, 26, 46],
          },
        ],
        { title: `CPD Record ${snap.cycle.year}` },
      ),
    };
  }

  private summarySheet(
    title: string,
    period: Period,
    plans: LearningPlan<Person>[],
    snap: ProgressSnapshot,
  ): SheetSpec {
    const head = [
      'Member',
      'Email',
      'Designation',
      'Line Manager',
      'Items Assigned',
      'Items Completed',
      'Items Outstanding',
      'Overdue Items',
      'Hours Required',
      'Hours Completed',
      'Hours Outstanding',
      'Completion %',
      'Items Confirmed',
      'Under Review',
      'Hours Confirmed',
      'Confirmed %',
    ];
    const rows = plans.map(({ person, summary: s }) => [
      person.fullName,
      person.email,
      this.designation(snap, person),
      person.lineManagerId ? (snap.peopleById.get(person.lineManagerId)?.fullName ?? '') : '',
      s.assigned,
      s.completed,
      s.outstanding,
      s.overdue,
      s.hoursAssigned,
      s.hoursCompleted,
      s.hoursOutstanding,
      n2(s.completionPct),
      s.confirmed,
      s.underReview,
      s.hoursConfirmed,
      n2(s.confirmedPct),
    ]);
    return {
      name: 'Summary',
      rows: [[title], ['Period', periodLabel(period)], ['Generated', snap.today], [], head, ...rows],
      headerRow: 4,
      titleRows: [0],
      columnWidths: [26, 38, 20, 24, 14, 15, 17, 13, 14, 15, 17, 13, 15, 13, 15, 12],
    };
  }

  private teamDetail(kind: TeamReportKind, plans: LearningPlan<Person>[], snap: ProgressSnapshot): SheetSpec {
    const rowsFor = (filter: (e: PlanEntry) => boolean) =>
      plans.flatMap((pl) => pl.entries.filter(filter).map((e) => ({ person: pl.person, e })));
    const evidenceFile = (e: PlanEntry) => e.completion?.evidence?.fileName ?? null;

    switch (kind) {
      case 'log': {
        const head = [
          'Member',
          'Email',
          'Designation',
          'Role',
          'Activity',
          'Category',
          'CPD Type',
          'Delivery',
          'Provider',
          'Mandatory',
          'Status',
          'Evidence',
          'Hours Required',
          'Hours Done',
          'Hours Outstanding',
          'Due Date',
          'Date Completed',
          'Days Overdue',
          'Evidence File',
          'Reflection',
        ];
        const rows = rowsFor(() => true).map(({ person, e }) => [
          person.fullName,
          person.email,
          this.designation(snap, person),
          ROLE_LABELS[person.role],
          e.item.title,
          this.name(snap, 'categories', e.item.categoryId),
          this.name(snap, 'cpdTypes', e.item.cpdTypeId),
          this.name(snap, 'deliveryTypes', e.item.deliveryTypeId),
          e.item.provider,
          e.item.isMandatory ? 'Yes' : 'No',
          statusLabel(e),
          evidenceLabel(e),
          e.item.hours,
          e.status === 'completed' ? e.item.hours : 0,
          e.status === 'completed' ? 0 : e.item.hours,
          e.item.dueDate,
          e.completion?.completedOn ?? null,
          e.daysOverdue,
          evidenceFile(e),
          e.completion?.reflection ?? null,
        ]);
        return {
          name: 'Learning Log',
          rows: [head, ...rows],
          headerRow: 0,
          columnWidths: [24, 36, 20, 16, 38, 24, 22, 20, 16, 11, 13, 14, 14, 12, 16, 12, 15, 13, 26, 44],
        };
      }
      case 'evidence': {
        const head = [
          'Member',
          'Activity',
          'Hours',
          'Completed On',
          'Evidence File',
          'Reflection',
          'Evidence',
          'Checked By',
          'Review Notes',
        ];
        const rows = rowsFor((e) => e.status === 'completed' || !!e.rejected).map(({ person, e }) => {
          const c = (e.completion ?? e.rejected)!;
          return [
            person.fullName,
            e.item.title,
            e.item.hours,
            c.completedOn,
            c.evidence?.fileName ?? null,
            c.reflection,
            evidenceLabel(e),
            checkedBy(e),
            c.reviewNotes,
          ];
        });
        return {
          name: 'Evidence',
          rows: [head, ...rows],
          headerRow: 0,
          columnWidths: [24, 38, 8, 14, 30, 50, 14, 16, 50],
        };
      }
      case 'icaew': {
        const head = [
          'Member',
          'Email',
          'Date',
          'Activity',
          'Provider',
          'Delivery',
          'CPD Type',
          'Category',
          'Hours',
          'Verifiable',
          'Evidence Confirmed',
          'Evidence File',
          'Reflection (what I learned / how I applied it)',
        ];
        const rows = rowsFor((e) => e.status === 'completed').map(({ person, e }) => [
          person.fullName,
          person.email,
          e.completion!.completedOn,
          e.item.title,
          e.item.provider,
          this.name(snap, 'deliveryTypes', e.item.deliveryTypeId),
          this.name(snap, 'cpdTypes', e.item.cpdTypeId),
          this.name(snap, 'categories', e.item.categoryId),
          e.item.hours,
          e.completion!.evidence ? 'Yes' : 'No',
          e.confirmed ? 'Yes' : 'Under review',
          evidenceFile(e),
          e.completion!.reflection,
        ]);
        return {
          name: 'ICAEW CPD Log',
          rows: [head, ...rows],
          headerRow: 0,
          columnWidths: [24, 36, 12, 38, 16, 20, 22, 24, 8, 11, 18, 28, 56],
        };
      }
      case 'acca': {
        const head = [
          'Member',
          'Email',
          'Date',
          'Activity',
          'Provider',
          'Units (1 unit = 1 hour)',
          'Verifiable',
          'Evidence Confirmed',
          'Evidence File',
          'Learning outcome / relevance to role',
        ];
        const rows = rowsFor((e) => e.status === 'completed').map(({ person, e }) => [
          person.fullName,
          person.email,
          e.completion!.completedOn,
          e.item.title,
          e.item.provider,
          e.item.hours,
          e.completion!.evidence ? 'Yes' : 'No',
          e.confirmed ? 'Yes' : 'Under review',
          evidenceFile(e),
          e.completion!.reflection,
        ]);
        return {
          name: 'ACCA CPD Log',
          rows: [head, ...rows],
          headerRow: 0,
          columnWidths: [24, 36, 12, 38, 16, 20, 11, 18, 28, 56],
        };
      }
      default: {
        const filter =
          kind === 'mandatory'
            ? (e: PlanEntry) => e.item.isMandatory
            : kind === 'outstanding'
              ? (e: PlanEntry) => e.status !== 'completed'
              : () => true;
        const head = [
          'Member',
          'Designation',
          'Activity',
          'Category',
          'CPD Type',
          'Delivery',
          'Provider',
          'Hours',
          'Due Date',
          'Status',
          'Evidence',
          'Days Overdue',
          'Completed On',
          'Evidence File',
        ];
        const rows = rowsFor(filter).map(({ person, e }) => [
          person.fullName,
          this.designation(snap, person),
          e.item.title,
          this.name(snap, 'categories', e.item.categoryId),
          this.name(snap, 'cpdTypes', e.item.cpdTypeId),
          this.name(snap, 'deliveryTypes', e.item.deliveryTypeId),
          e.item.provider,
          e.item.hours,
          e.item.dueDate,
          statusLabel(e),
          evidenceLabel(e),
          e.daysOverdue,
          e.completion?.completedOn ?? null,
          evidenceFile(e),
        ]);
        return {
          name: 'Detail',
          rows: [head, ...rows],
          headerRow: 0,
          columnWidths: [24, 20, 38, 24, 22, 20, 16, 8, 12, 12, 14, 13, 14, 26],
        };
      }
    }
  }

  private designation(snap: ProgressSnapshot, p: Person): string {
    return p.designationId != null ? (snap.dtoContext.designations.get(p.designationId)?.name ?? '') : '';
  }

  private name(
    snap: ProgressSnapshot,
    list: 'categories' | 'cpdTypes' | 'deliveryTypes',
    id: number,
  ): string {
    return snap.lookups[list].find((x) => x.id === id)?.name ?? '';
  }
}
