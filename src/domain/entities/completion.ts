import type { IsoDate } from '../../shared/utils/dates.js';
import type { ReviewStatus } from '../enums.js';
import type { EvidenceFile } from '../value-objects/evidence-file.js';

/** A person's record of finishing a Learning Item (table: completions). */
export interface Completion {
  id: string;
  profileId: string;
  itemId: string;
  completedOn: IsoDate;
  reflection: string | null;
  evidence: EvidenceFile | null;
  /** SHA-256 of the evidence file (duplicate detection). */
  evidenceSha256: string | null;
  reviewStatus: ReviewStatus;
  reviewSource: 'ai' | 'manual' | null;
  /** Why it was flagged/rejected (shown to the person and reviewers). */
  reviewNotes: string | null;
  reviewedAt: Date | null;
  submittedAt: Date;
  updatedAt: Date;
}

export type CompletionUpsert = Pick<Completion, 'profileId' | 'itemId' | 'completedOn' | 'reflection' | 'evidence' | 'evidenceSha256'>;

export interface ReviewDecision {
  status: Exclude<ReviewStatus, 'not_reviewed'>;
  source: 'ai' | 'manual';
  notes: string | null;
  reviewedBy: string | null;
}
