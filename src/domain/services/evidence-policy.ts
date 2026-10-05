import { daysBetween, isIsoDate, type IsoDate } from '../../shared/utils/dates.js';
import type { EvidenceAnalysis, EvidenceExpectation } from '../value-objects/evidence-analysis.js';

/**
 * The firm's rules for automatically accepting evidence (deterministic — no AI).
 * The AI reads the document; this decides. Anything not clearly fine is
 * flagged for a person: the AI never rejects anyone on its own.
 */

export interface EvidencePolicyOptions {
  /** Below this confidence the result always goes to a reviewer. */
  minConfidence: number;
  /** How far the certificate date may be from the date the person entered. */
  dateToleranceDays: number;
}

export const DEFAULT_EVIDENCE_POLICY: EvidencePolicyOptions = { minConfidence: 0.8, dateToleranceDays: 14 };

export interface EvidencePolicyContext {
  expected: EvidenceExpectation;
  today: IsoDate;
  /** Start of the learning year the item belongs to. */
  cycleStartsOn: IsoDate;
  /** Other completions that used the exact same file (by fingerprint). */
  duplicateUses: number;
}

export interface EvidenceDecision {
  decision: 'verified' | 'flagged';
  /** Plain-English reasons; empty when verified. Shown to reviewers and the person. */
  reasons: string[];
}

export function decideEvidence(
  a: EvidenceAnalysis,
  ctx: EvidencePolicyContext,
  opts: EvidencePolicyOptions = DEFAULT_EVIDENCE_POLICY,
): EvidenceDecision {
  const reasons: string[] = [];
  const e = ctx.expected;

  // Not a certificate at all → nothing else matters.
  if (!a.isCertificate) {
    return { decision: 'flagged', reasons: [`This doesn't look like a completion certificate (${a.documentType || 'unknown document'}).`] };
  }

  if (ctx.duplicateUses > 0) {
    reasons.push(`The same file was already submitted for ${ctx.duplicateUses === 1 ? 'another completion' : `${ctx.duplicateUses} other completions`}.`);
  }

  // Name: must be clearly the submitter. The model's "match" is double-checked against the
  // name it actually read, so a hallucinated or injected verdict can't pass on its own.
  if (a.checks.name === 'mismatch') reasons.push(`The name on the certificate (${a.extracted.participantName ?? 'unknown'}) is not ${e.personName}.`);
  else if (a.checks.name !== 'match' || !a.extracted.participantName) reasons.push('The participant name could not be confirmed on the certificate.');
  else if (!namesAgree(a.extracted.participantName, e.personName)) {
    reasons.push(`The name on the certificate (${a.extracted.participantName}) could not be matched to ${e.personName}.`);
  }

  // Title/topic: wording may differ, the subject must be the same (that judgement is the model's).
  if (a.checks.title === 'mismatch') reasons.push(`The certificate is for "${a.extracted.courseTitle ?? 'a different course'}", not "${e.itemTitle}".`);
  else if (a.checks.title === 'partial') reasons.push(`The course "${a.extracted.courseTitle ?? '?'}" only partly matches "${e.itemTitle}".`);
  else if (a.checks.title === 'not_found' || !a.extracted.courseTitle) reasons.push('No course title could be found on the certificate.');

  // Provider: only a clear mismatch matters (internal courses often omit it).
  if (a.checks.provider === 'mismatch' && a.extracted.provider) {
    reasons.push(`The provider on the certificate (${a.extracted.provider}) differs from the expected provider (${e.provider}).`);
  }

  // Dates: only checked when the certificate shows one.
  const certDate = a.extracted.completionDate;
  if (certDate && isIsoDate(certDate)) {
    if (certDate > ctx.today) reasons.push(`The certificate date (${certDate}) is in the future.`);
    else if (certDate < ctx.cycleStartsOn) reasons.push(`The certificate date (${certDate}) is before this learning year started (${ctx.cycleStartsOn}).`);
    if (Math.abs(daysBetween(certDate, e.completedOn)) > opts.dateToleranceDays) {
      reasons.push(`The certificate date (${certDate}) is more than ${opts.dateToleranceDays} days from the completion date entered (${e.completedOn}).`);
    }
  }

  // Hours: only checked when the certificate shows them.
  const hours = a.extracted.hours;
  if (hours !== null && Number.isFinite(hours) && hours + 1e-9 < e.hours) {
    reasons.push(`The certificate shows ${hours} h; this item requires ${e.hours} h.`);
  }

  // Kept general on purpose: the specific signs are shown to reviewers only (EvidenceCheck),
  // so nobody learns exactly what to fix in an edited certificate.
  if (a.tamperingSigns.length > 0) reasons.push('Possible signs of editing were found on the document.');

  if (reasons.length === 0 && a.confidence < opts.minConfidence) {
    reasons.push(`The automatic check wasn't confident enough (${Math.round(a.confidence * 100)}%).`);
  }

  return reasons.length === 0 ? { decision: 'verified', reasons: [] } : { decision: 'flagged', reasons };
}

const nameTokens = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

/**
 * Deterministic sanity check on a name the model says matches: the surname
 * (last word) must appear, and the first name must appear in full or as an
 * initial when the certificate shows more than one word. Allows middle names,
 * initials, case, accents and "Surname, First" order; a different person fails.
 */
export function namesAgree(onCertificate: string, expected: string): boolean {
  const cert = nameTokens(onCertificate);
  const want = nameTokens(expected);
  if (cert.length === 0 || want.length === 0) return false;
  const surname = want[want.length - 1]!;
  if (!cert.includes(surname)) return false;
  if (want.length === 1 || cert.length === 1) return true;
  const first = want[0]!;
  return cert.some((t) => t !== surname && (t === first || (t.length === 1 && t === first[0])));
}
