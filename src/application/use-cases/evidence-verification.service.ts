import type { Completion } from '../../domain/entities/completion.js';
import type { EvidenceCheck } from '../../domain/entities/evidence-check.js';
import type { Person } from '../../domain/entities/person.js';
import type { AuditLog } from '../../domain/repositories/audit-log.js';
import type { CompletionRepository } from '../../domain/repositories/completion-repository.js';
import type { CycleRepository } from '../../domain/repositories/cycle-repository.js';
import type { EvidenceCheckRepository } from '../../domain/repositories/evidence-check-repository.js';
import type { LearningItemRepository } from '../../domain/repositories/learning-item-repository.js';
import type { LookupRepository } from '../../domain/repositories/lookup-repository.js';
import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import { can, type Actor } from '../../domain/services/access-policy.js';
import { decideEvidence, type EvidencePolicyOptions } from '../../domain/services/evidence-policy.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../shared/errors/app-errors.js';
import type { Logger } from '../../shared/utils/logger.js';
import { toCompletionDto, type CompletionDto } from '../dto/learning-item.dto.js';
import type { Clock } from '../ports/clock.js';
import { EvidenceAnalyzerError, type EvidenceAnalyzer } from '../ports/evidence-analyzer.js';
import type { FileStorage } from '../ports/file-storage.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

export interface EvidenceVerificationOptions {
  /** Master switch; when false nothing is queued and evidence waits for a person. */
  enabled: boolean;
  maxAttempts: number;
  policy: EvidencePolicyOptions;
}

export type ManualDecision = 'verified' | 'rejected';

/**
 * Wait before retry n (1-based). Spread over ~1.5 h so a demand spike on the
 * AI provider passes; ±20% jitter so queued checks don't all retry together.
 */
const RETRY_DELAYS_MS = [60_000, 3 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000, 30 * 60_000];
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!;
  return Math.round(base * (0.8 + random() * 0.4));
}
/** A job still 'running' after this long belongs to a crashed process. */
const STALE_AFTER_MS = 10 * 60_000;
const FAILED_NOTE = 'The automatic check could not be completed - please review this evidence manually.';
const BUSY_NOTE =
  'The automatic check service was unavailable for a long time - please review this evidence manually or use "Re-run check".';

/**
 * Automated evidence verification (ADR 0005).
 *
 *   upload → enqueue → worker: processNext() → AI reads the file → firm policy
 *   (decideEvidence) → verified (source ai) or flagged → Learning Team decides.
 *
 * The AI never rejects: anything not clearly fine is flagged for a person, and
 * the AI never overrides a decision a person already made.
 */
export class EvidenceVerificationService {
  constructor(
    private readonly checks: EvidenceCheckRepository,
    private readonly completions: CompletionRepository,
    private readonly items: LearningItemRepository,
    private readonly cycles: CycleRepository,
    private readonly people: PersonRepository,
    private readonly lookups: LookupRepository,
    private readonly storage: FileStorage,
    private readonly analyzer: EvidenceAnalyzer | null,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: EvidenceVerificationOptions,
  ) {}

  get enabled(): boolean {
    return this.options.enabled && this.analyzer !== null;
  }

  /** Queue a check for the completion's current file (no-op when disabled or no file). */
  async enqueue(completion: Completion): Promise<EvidenceCheck | null> {
    if (!this.enabled || !completion.evidence) return null;
    return this.checks.enqueue(completion.id, completion.evidence.path);
  }

  /** Run one due job. Returns false when the queue is empty. */
  async processNext(): Promise<boolean> {
    if (!this.enabled) return false;
    const job = await this.checks.claimNext();
    if (!job) return false;
    await this.run(job);
    return true;
  }

  /** Put jobs orphaned by a crash back in the queue. */
  async recoverStale(): Promise<number> {
    return this.checks.requeueStale(STALE_AFTER_MS);
  }

  /** Learning Team: approve or reject a submission (overrides the automatic result). */
  async decide(actor: Actor, completionId: string, decision: ManualDecision, note?: string | null): Promise<CompletionDto> {
    if (!can(actor, 'decideEvidence')) throw new ForbiddenError();
    const completion = await this.completions.findById(completionId);
    if (!completion) throw new NotFoundError('completion', 'COMPLETION_NOT_FOUND');
    const notes = note?.trim() || null;
    if (decision === 'rejected' && !notes) {
      throw new BusinessRuleError('Give a reason so the person knows what to fix.', 'REJECTION_REASON_REQUIRED');
    }
    return this.uow.run(async () => {
      const saved = await this.completions.setReview(completion.id, {
        status: decision,
        source: 'manual',
        notes,
        reviewedBy: actor.id,
      });
      await this.audit.record({
        actorId: actor.id,
        action: `evidence.${decision}`,
        entityType: 'completion',
        entityId: completion.id,
        metadata: { previous: completion.reviewStatus, note: notes },
      });
      const latest = await this.checks.latestFor([saved.id]);
      return toCompletionDto(saved, latest.get(saved.id), true);
    });
  }

  /** Learning Team: run the automatic check again (e.g. after a provider outage). */
  async recheck(actor: Actor, completionId: string): Promise<CompletionDto> {
    if (!can(actor, 'decideEvidence')) throw new ForbiddenError();
    if (!this.enabled) {
      throw new BusinessRuleError('Automatic evidence checks are turned off.', 'VERIFICATION_DISABLED');
    }
    const completion = await this.completions.findById(completionId);
    if (!completion?.evidence) throw new NotFoundError('evidence', 'EVIDENCE_NOT_FOUND');
    const check = await this.checks.enqueue(completion.id, completion.evidence.path);
    await this.audit.record({ actorId: actor.id, action: 'evidence.recheck', entityType: 'completion', entityId: completion.id });
    return toCompletionDto(completion, check, true);
  }

  private async run(job: EvidenceCheck): Promise<void> {
    const completion = await this.completions.findById(job.completionId);
    if (!completion?.evidence || completion.evidence.path !== job.evidencePath) {
      await this.checks.supersede(job.id); // the file was replaced or removed meanwhile
      return;
    }
    try {
      const [item, person, lookups] = await Promise.all([
        this.items.findById(completion.itemId),
        this.people.findById(completion.profileId),
        this.lookups.all(),
      ]);
      const cycle = item ? await this.cycles.findById(item.cycleId) : null;
      if (!item || !person || !cycle) throw new EvidenceAnalyzerError('Item, person or learning year missing.', false);

      const expected = {
        personName: person.fullName,
        itemTitle: item.title,
        itemDescription: item.description,
        provider: item.provider,
        hours: item.hours,
        completedOn: completion.completedOn,
        category: lookups.categories.find((c) => c.id === item.categoryId)?.name ?? 'Other',
        deliveryType: lookups.deliveryTypes.find((d) => d.id === item.deliveryTypeId)?.name ?? 'Other',
      };
      const bytes = await this.storage.download(completion.evidence.path);
      const out = await this.analyzer!.analyze({ bytes, mimeType: completion.evidence.mimeType, expected });
      const duplicateUses = completion.evidenceSha256
        ? await this.completions.countBySha256(completion.evidenceSha256, completion.id)
        : 0;
      const { decision, reasons } = decideEvidence(
        out.analysis,
        { expected, today: this.clock.today(), cycleStartsOn: cycle.startsOn, duplicateUses },
        this.options.policy,
      );

      await this.uow.run(async () => {
        const stored = await this.checks.complete(job.id, { ...out, decision, reasons });
        if (!stored) return; // superseded while the model was reading
        await this.applyAutomaticResult(completion.id, job.evidencePath, decision, reasons.join(' '));
      });
      this.logger.info('evidence checked', {
        completionId: completion.id,
        decision,
        model: out.model,
        usage: { in: out.inputTokens, out: out.outputTokens },
      });
    } catch (err) {
      await this.handleFailure(job, completion.id, err);
    }
  }

  /** Only touches the completion if no person has decided and the file is unchanged. */
  private async applyAutomaticResult(
    completionId: string,
    path: string,
    decision: 'verified' | 'flagged',
    notes: string,
  ): Promise<void> {
    const current = await this.completions.findById(completionId);
    if (!current || current.evidence?.path !== path || current.reviewSource === 'manual') return;
    await this.completions.setReview(completionId, {
      status: decision,
      source: 'ai',
      notes: decision === 'flagged' ? notes : null,
      reviewedBy: null,
    });
  }

  private async handleFailure(job: EvidenceCheck, completionId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = !(err instanceof EvidenceAnalyzerError) || err.retryable;
    if (retryable && job.attempts < this.options.maxAttempts) {
      await this.checks.fail(job.id, message, retryDelayMs(job.attempts));
      this.logger.warn('evidence check failed, will retry', { completionId, attempt: job.attempts, error: message });
      return;
    }
    this.logger.error('evidence check failed', { completionId, attempts: job.attempts, error: message });
    await this.uow.run(async () => {
      if (!(await this.checks.fail(job.id, message, null))) return;
      const busy = err instanceof EvidenceAnalyzerError && err.busy;
      await this.applyAutomaticResult(completionId, job.evidencePath, 'flagged', busy ? BUSY_NOTE : FAILED_NOTE);
    });
  }
}
