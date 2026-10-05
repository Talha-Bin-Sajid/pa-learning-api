import type { EvidenceCheck, EvidenceCheckResult } from '../entities/evidence-check.js';

/** Persistence + job-queue operations for automated evidence checks. Queue timing uses database time. */
export interface EvidenceCheckRepository {
  /** Queue a check for this file; any older queued/running check of the completion is superseded. */
  enqueue(completionId: string, evidencePath: string): Promise<EvidenceCheck>;
  /** Atomically take the oldest due job (status → running, attempts + 1). */
  claimNext(): Promise<EvidenceCheck | null>;
  /** Store the result. False when the job is no longer running (e.g. superseded meanwhile). */
  complete(id: string, result: EvidenceCheckResult): Promise<boolean>;
  /** Failure: re-queue after `retryInMs`, or mark failed for good when null. False when no longer running. */
  fail(id: string, error: string, retryInMs: number | null): Promise<boolean>;
  /** The file this job was for has been replaced. */
  supersede(id: string): Promise<void>;
  /** Re-queue jobs left `running` by a crashed process. */
  requeueStale(olderThanMs: number): Promise<number>;
  /** Most recent check per completion. */
  latestFor(completionIds: string[]): Promise<Map<string, EvidenceCheck>>;
}
