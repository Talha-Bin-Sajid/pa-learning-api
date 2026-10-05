import type { EvidenceAnalysis } from '../value-objects/evidence-analysis.js';

export type EvidenceCheckStatus = 'queued' | 'running' | 'done' | 'failed' | 'superseded';

/** One automated check of one evidence file (table: evidence_checks). Also the job queue. */
export interface EvidenceCheck {
  id: string;
  completionId: string;
  evidencePath: string;
  status: EvidenceCheckStatus;
  attempts: number;
  nextAttemptAt: Date;
  provider: string | null;
  model: string | null;
  analysis: EvidenceAnalysis | null;
  decision: 'verified' | 'flagged' | null;
  reasons: string[];
  confidence: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface EvidenceCheckResult {
  provider: string;
  model: string;
  analysis: EvidenceAnalysis;
  decision: 'verified' | 'flagged';
  reasons: string[];
  inputTokens: number | null;
  outputTokens: number | null;
}
