import { createHash, randomUUID } from 'node:crypto';
import type { CompletionRepository } from '../../domain/repositories/completion-repository.js';
import type { CycleRepository } from '../../domain/repositories/cycle-repository.js';
import type { LearningItemRepository } from '../../domain/repositories/learning-item-repository.js';
import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import { can, canViewPerson, type Actor } from '../../domain/services/access-policy.js';
import { inPeriod, isAssigned, type Period } from '../../domain/services/learning-progress.js';
import type { Person } from '../../domain/entities/person.js';
import {
  safeFileName,
  validateEvidenceUpload,
  type EvidenceFile,
} from '../../domain/value-objects/evidence-file.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../shared/errors/app-errors.js';
import type { IsoDate } from '../../shared/utils/dates.js';
import type { Logger } from '../../shared/utils/logger.js';
import {
  toCompletionDto,
  toLearningItemDto,
  type CompletionDto,
  type LearningItemDto,
} from '../dto/learning-item.dto.js';
import { toPersonDto, type PersonDto } from '../dto/person.dto.js';
import type { Clock } from '../ports/clock.js';
import type { FileStorage } from '../ports/file-storage.js';
import type { ProgressSnapshotLoader } from '../services/progress-snapshot.js';
import type { EvidenceVerificationService } from './evidence-verification.service.js';

export interface SubmitCompletionInput {
  completedOn: IsoDate;
  reflection?: string | null;
  file?: { bytes: Uint8Array; originalName: string } | null;
}

export interface EvidenceRecordDto {
  completion: CompletionDto;
  person: PersonDto;
  item: LearningItemDto;
}

const SIGNED_URL_SECONDS = 300;

export class CompletionsService {
  constructor(
    private readonly completions: CompletionRepository,
    private readonly items: LearningItemRepository,
    private readonly cycles: CycleRepository,
    private readonly people: PersonRepository,
    private readonly storage: FileStorage,
    private readonly snapshots: ProgressSnapshotLoader,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly verification: EvidenceVerificationService,
  ) {}

  /**
   * Marks an item complete for the signed-in person, or replaces their earlier
   * submission (business rule 6). Certificate items need a file; acknowledgement
   * items do not.
   */
  async submit(
    actor: Person,
    itemId: string,
    input: SubmitCompletionInput,
  ): Promise<{ completion: CompletionDto; created: boolean }> {
    const item = await this.items.findById(itemId);
    if (!item || item.archivedAt || !isAssigned(item, actor)) {
      throw new NotFoundError('learning item', 'ITEM_NOT_FOUND'); // never reveal items outside your plan
    }
    const cycle = (await this.cycles.findById(item.cycleId))!;
    const today = this.clock.today();
    if (input.completedOn > today)
      throw new BusinessRuleError('The completion date cannot be in the future.', 'COMPLETION_IN_FUTURE');
    if (input.completedOn < cycle.startsOn) {
      throw new BusinessRuleError(
        `The completion date must be on or after the start of the ${cycle.year} programme.`,
        'COMPLETION_BEFORE_CYCLE',
      );
    }

    const existing = await this.completions.find(actor.id, itemId);
    if (item.evidenceMode === 'certificate' && !input.file && !existing?.evidence) {
      throw new BusinessRuleError(
        'Attach a certificate or screenshot to complete this item.',
        'EVIDENCE_REQUIRED',
      );
    }
    // A rejection stands until different evidence is uploaded: re-submitting without a
    // file (or with the very same file) must not quietly reset the reviewer's decision.
    const rejected = existing?.reviewStatus === 'rejected' && existing.evidence ? existing : null;
    if (rejected && !input.file) {
      throw new BusinessRuleError('This evidence was rejected - upload the correct certificate.', 'EVIDENCE_REJECTED');
    }
    const newSha256 = input.file ? createHash('sha256').update(input.file.bytes).digest('hex') : null;
    if (rejected && newSha256 && newSha256 === rejected.evidenceSha256) {
      throw new BusinessRuleError(
        'This is the same file that was rejected - upload the correct certificate.',
        'EVIDENCE_REJECTED',
      );
    }

    let evidence: EvidenceFile | null = existing?.evidence ?? null;
    let evidenceSha256 = existing?.evidenceSha256 ?? null;
    let uploadedPath: string | null = null;
    if (input.file) {
      const { mimeType, extension } = validateEvidenceUpload(input.file.bytes);
      uploadedPath = `${cycle.year}/${actor.id}/${item.id}/${randomUUID()}.${extension}`;
      await this.storage.upload(uploadedPath, input.file.bytes, mimeType);
      evidence = {
        path: uploadedPath,
        fileName: safeFileName(input.file.originalName, `evidence.${extension}`),
        mimeType,
        sizeBytes: input.file.bytes.length,
      };
      evidenceSha256 = newSha256;
    }

    try {
      const saved = await this.completions.upsert({
        profileId: actor.id,
        itemId,
        completedOn: input.completedOn,
        reflection: input.reflection?.trim() || null,
        evidence,
        evidenceSha256,
      });
      // Replaced file: remove the old object (best effort - the DB is the source of truth).
      if (uploadedPath && existing?.evidence && existing.evidence.path !== uploadedPath) {
        await this.storage
          .remove(existing.evidence.path)
          .catch((err: unknown) =>
            this.logger.warn('could not remove replaced evidence', { path: existing.evidence?.path, err }),
          );
      }
      // Every (re)submission resets the review, so the evidence is checked again.
      const check = await this.verification.enqueue(saved).catch((err: unknown) => {
        this.logger.error('could not queue evidence check', { completionId: saved.id, err });
        return null;
      });
      return { completion: toCompletionDto(saved, check, can(actor, 'reviewEvidence')), created: !existing };
    } catch (err) {
      if (uploadedPath) await this.storage.remove(uploadedPath).catch(() => undefined);
      throw err;
    }
  }

  /** My uploaded evidence in a cycle. */
  async mine(actor: Person, cycleId?: string): Promise<EvidenceRecordDto[]> {
    const snap = await this.snapshots.load(cycleId);
    return this.records(
      snap,
      snap.completions.filter((c) => c.profileId === actor.id && c.evidence),
      can(actor, 'reviewEvidence'),
    );
  }

  /** Evidence Review register (Learning Team, HR). */
  async register(
    actor: Actor,
    cycleId?: string,
    period?: Period,
    profileId?: string,
  ): Promise<EvidenceRecordDto[]> {
    if (!can(actor, 'reviewEvidence')) throw new ForbiddenError();
    const snap = await this.snapshots.load(cycleId);
    return this.records(
      snap,
      snap.completions.filter(
        (c) => inPeriod(c.completedOn, period) && (!profileId || c.profileId === profileId),
      ),
      true,
    );
  }

  /** Short-lived link to view one evidence file, after an authorization check. */
  async evidenceUrl(
    actor: Actor,
    completionId: string,
  ): Promise<{ url: string; expiresAt: string; fileName: string; mimeType: string }> {
    const completion = await this.completions.findById(completionId);
    const owner = completion ? await this.people.findById(completion.profileId) : null;
    if (!completion || !owner || !canViewPerson(actor, owner) || !completion.evidence) {
      throw new NotFoundError('evidence', 'EVIDENCE_NOT_FOUND');
    }
    const url = await this.storage.signedUrl(completion.evidence.path, SIGNED_URL_SECONDS);
    return {
      url,
      expiresAt: new Date(this.clock.now().getTime() + SIGNED_URL_SECONDS * 1000).toISOString(),
      fileName: completion.evidence.fileName,
      mimeType: completion.evidence.mimeType,
    };
  }

  private records(
    snap: Awaited<ReturnType<ProgressSnapshotLoader['load']>>,
    list: typeof snap.completions,
    detailedChecks: boolean,
  ): EvidenceRecordDto[] {
    const itemCtx = { lookups: snap.lookups, peopleById: snap.peopleById };
    return list.flatMap((c) => {
      const person = snap.peopleById.get(c.profileId);
      const item = snap.itemsById.get(c.itemId);
      if (!person || !item) return [];
      return [
        {
          completion: toCompletionDto(c, snap.checks.get(c.id), detailedChecks),
          person: toPersonDto(person, snap.dtoContext),
          item: toLearningItemDto(item, itemCtx),
        },
      ];
    });
  }
}
