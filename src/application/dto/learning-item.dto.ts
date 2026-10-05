import type { Completion } from '../../domain/entities/completion.js';
import type { EvidenceCheck } from '../../domain/entities/evidence-check.js';
import type { EvidenceAnalysis } from '../../domain/value-objects/evidence-analysis.js';
import type { LearningItem } from '../../domain/entities/learning-item.js';
import type { Lookups } from '../../domain/entities/lookups.js';
import type { Person } from '../../domain/entities/person.js';
import type { PlanEntry, ProgressSummary } from '../../domain/services/learning-progress.js';
import type { EvidenceMode, ItemStatus, ReviewStatus } from '../../domain/enums.js';

export interface Named {
  id: number;
  name: string;
}

export interface LearningItemDto {
  id: string;
  cycleId: string;
  title: string;
  category: Named;
  cpdType: Named;
  deliveryType: Named;
  provider: string;
  hours: number;
  dueDate: string | null;
  isMandatory: boolean;
  evidenceMode: EvidenceMode;
  link: string | null;
  description: string | null;
  audience: {
    all: boolean;
    designations: Named[];
    people: { id: string; fullName: string }[];
    /** Human summary, e.g. "All staff" or "Senior Accountant, Manager, Priya Raman". */
    label: string;
  };
  archived: boolean;
}

export interface CompletionDto {
  id: string;
  completedOn: string;
  reflection: string | null;
  evidence: { fileName: string; mimeType: string; sizeBytes: number } | null;
  reviewStatus: ReviewStatus;
  /** Who made the review decision: the automatic check or a person. */
  reviewSource: 'ai' | 'manual' | null;
  /** Why it was flagged or rejected. */
  reviewNotes: string | null;
  reviewedAt: string | null;
  submittedAt: string;
  /** Latest automated check of the evidence file (null when none was run). */
  check: EvidenceCheckDto | null;
}

export interface EvidenceCheckDto {
  status: 'queued' | 'running' | 'done' | 'failed';
  decision: 'verified' | 'flagged' | null;
  reasons: string[];
  confidence: number | null;
  documentType: string | null;
  summary: string | null;
  extracted: EvidenceAnalysis['extracted'] | null;
  checks: EvidenceAnalysis['checks'] | null;
  tamperingSigns: string[];
  model: string | null;
  finishedAt: string | null;
}

export interface PlanEntryDto {
  item: LearningItemDto;
  status: ItemStatus;
  /** Completed and the evidence is confirmed; false = still under review (or not completed). */
  confirmed: boolean;
  daysOverdue: number;
  daysUntilDue: number | null;
  completion: CompletionDto | null;
  /** The rejected submission, when a reviewer turned it down (item is outstanding again). */
  rejected: CompletionDto | null;
}

export type ProgressSummaryDto = ProgressSummary;

export interface ItemDtoContext {
  lookups: Lookups;
  peopleById: Map<string, Pick<Person, 'id' | 'fullName'>>;
  /** Latest evidence checks by completion id (optional). */
  checks?: Map<string, EvidenceCheck>;
  /** Include the AI's detailed findings (reviewers only - see toEvidenceCheckDto). */
  detailedChecks?: boolean;
}

const named = (list: { id: number; name: string }[], id: number): Named =>
  list.find((x) => x.id === id) ?? { id, name: 'Unknown' };

export function toLearningItemDto(item: LearningItem, ctx: ItemDtoContext): LearningItemDto {
  const designations = item.audience.designationIds.map((id) => named(ctx.lookups.designations, id));
  const people = item.audience.profileIds.map((id) => ({ id, fullName: ctx.peopleById.get(id)?.fullName ?? 'Former member' }));
  const label = item.audience.all ? 'All staff' : [...designations.map((d) => d.name), ...people.map((p) => p.fullName)].join(', ');
  return {
    id: item.id,
    cycleId: item.cycleId,
    title: item.title,
    category: named(ctx.lookups.categories, item.categoryId),
    cpdType: named(ctx.lookups.cpdTypes, item.cpdTypeId),
    deliveryType: named(ctx.lookups.deliveryTypes, item.deliveryTypeId),
    provider: item.provider,
    hours: item.hours,
    dueDate: item.dueDate,
    isMandatory: item.isMandatory,
    evidenceMode: item.evidenceMode,
    link: item.link,
    description: item.description,
    audience: { all: item.audience.all, designations, people, label },
    archived: item.archivedAt !== null,
  };
}

/**
 * `detailed` = reviewer view. Staff only get the outcome (status / decision / the
 * plain reasons); the AI's readings, verdicts, confidence and editing signs are
 * withheld so nobody can use them to tune a fake certificate.
 */
export function toEvidenceCheckDto(k: EvidenceCheck, detailed = false): EvidenceCheckDto | null {
  if (k.status === 'superseded') return null;
  if (!detailed) {
    return {
      status: k.status,
      decision: k.decision,
      reasons: [],
      confidence: null,
      documentType: null,
      summary: null,
      extracted: null,
      checks: null,
      tamperingSigns: [],
      model: null,
      finishedAt: k.finishedAt?.toISOString() ?? null,
    };
  }
  return {
    status: k.status,
    decision: k.decision,
    reasons: k.reasons,
    confidence: k.confidence,
    documentType: k.analysis?.documentType ?? null,
    summary: k.analysis?.summary ?? null,
    extracted: k.analysis?.extracted ?? null,
    checks: k.analysis?.checks ?? null,
    tamperingSigns: k.analysis?.tamperingSigns ?? [],
    model: k.model,
    finishedAt: k.finishedAt?.toISOString() ?? null,
  };
}

export function toCompletionDto(c: Completion, check?: EvidenceCheck | null, detailed = false): CompletionDto {
  return {
    id: c.id,
    completedOn: c.completedOn,
    reflection: c.reflection,
    evidence: c.evidence ? { fileName: c.evidence.fileName, mimeType: c.evidence.mimeType, sizeBytes: c.evidence.sizeBytes } : null,
    reviewStatus: c.reviewStatus,
    reviewSource: c.reviewSource,
    reviewNotes: c.reviewNotes,
    reviewedAt: c.reviewedAt?.toISOString() ?? null,
    submittedAt: c.submittedAt.toISOString(),
    check: check ? toEvidenceCheckDto(check, detailed) : null,
  };
}

export function toPlanEntryDto(e: PlanEntry, ctx: ItemDtoContext): PlanEntryDto {
  return {
    item: toLearningItemDto(e.item, ctx),
    status: e.status,
    confirmed: e.confirmed,
    daysOverdue: e.daysOverdue,
    daysUntilDue: e.daysUntilDue,
    completion: e.completion ? toCompletionDto(e.completion, ctx.checks?.get(e.completion.id), ctx.detailedChecks) : null,
    rejected: e.rejected ? toCompletionDto(e.rejected, ctx.checks?.get(e.rejected.id), ctx.detailedChecks) : null,
  };
}
