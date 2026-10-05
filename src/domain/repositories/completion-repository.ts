import type { Completion, CompletionUpsert, ReviewDecision } from '../entities/completion.js';

export interface CompletionRepository {
  /** All completions of items in a cycle (archived items included - history is kept). */
  listByCycle(cycleId: string): Promise<Completion[]>;
  findById(id: string): Promise<Completion | null>;
  find(profileId: string, itemId: string): Promise<Completion | null>;
  /** Insert or replace the person's completion of the item; resets any review. */
  upsert(completion: CompletionUpsert): Promise<Completion>;
  /** How many *other* completions used a file with this fingerprint. */
  countBySha256(sha256: string, excludeCompletionId: string): Promise<number>;
  /** Record a review outcome (AI or manual). */
  setReview(id: string, decision: ReviewDecision): Promise<Completion>;
}
