import { z } from 'zod';
import type { EvidenceAnalysis } from '../../domain/value-objects/evidence-analysis.js';
import { isIsoDate } from '../../shared/utils/dates.js';

/**
 * Validates what a model returns. Model output is untrusted input: anything
 * malformed is normalised (unknown → null / not_found) rather than trusted.
 */

const text = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => (v && v.trim() ? v.trim().slice(0, max) : null));

const check = z.enum(['match', 'partial', 'mismatch', 'not_found']).catch('not_found');

export const EvidenceAnalysisSchema = z.object({
  isCertificate: z.boolean(),
  documentType: text(200).transform((v) => v ?? 'unknown'),
  extracted: z.object({
    participantName: text(200),
    courseTitle: text(300),
    provider: text(200),
    completionDate: text(20).transform((v) => (v && isIsoDate(v) ? v : null)),
    hours: z
      .number()
      .nullish()
      .transform((v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1000 ? v : null)),
    certificateId: text(100),
  }),
  checks: z.object({ name: check, title: check, provider: check }),
  tamperingSigns: z
    .array(z.string())
    .nullish()
    .transform((v) => (v ?? []).map((s) => s.trim().slice(0, 300)).filter(Boolean).slice(0, 10)),
  confidence: z.number().transform((v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)),
  summary: text(1000).transform((v) => v ?? ''),
});

/** Parse raw model JSON text. Throws on anything that isn't the expected shape. */
export function parseEvidenceAnalysis(raw: string): EvidenceAnalysis {
  return EvidenceAnalysisSchema.parse(JSON.parse(raw));
}
