import type { Completion } from '../../domain/entities/completion.js';
import type { ProgressSnapshot } from './progress-snapshot.js';

/** Evidence waiting longer than this without a decision gets the Learning Team nudged. */
export const REVIEW_NUDGE_DAYS = 5;
const DAY_MS = 86_400_000;

/**
 * Submissions with a file that still need a person: flagged by the automatic
 * check, or never confirmed (checks off / check failed). Ones still being
 * checked (queued/running) are not counted yet.
 */
export function awaitingReview(snap: ProgressSnapshot, include: (personId: string) => boolean = () => true): Completion[] {
  return snap.completions.filter((c) => {
    if (!c.evidence || !include(c.profileId)) return false;
    if (c.reviewStatus === 'flagged') return true;
    if (c.reviewStatus !== 'not_reviewed') return false;
    const check = snap.checks.get(c.id);
    return !check || check.status === 'failed' || check.status === 'done';
  });
}

/** Of `list`, those submitted more than REVIEW_NUDGE_DAYS days before `today`. */
export function waitingTooLong(list: Completion[], today: string): Completion[] {
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - REVIEW_NUDGE_DAYS * DAY_MS;
  return list.filter((c) => c.submittedAt.getTime() < cutoff);
}
