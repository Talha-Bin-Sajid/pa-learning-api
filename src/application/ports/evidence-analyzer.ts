import type { EvidenceAnalysis, EvidenceExpectation } from '../../domain/value-objects/evidence-analysis.js';

export interface EvidenceAnalyzerInput {
  bytes: Uint8Array;
  mimeType: string;
  expected: EvidenceExpectation;
}

export interface EvidenceAnalyzerOutput {
  provider: string;
  model: string;
  analysis: EvidenceAnalysis;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Reads an evidence file and compares it with what was claimed (an AI model behind it). */
export interface EvidenceAnalyzer {
  analyze(input: EvidenceAnalyzerInput): Promise<EvidenceAnalyzerOutput>;
}

/**
 * Analyzer failure. `retryable` = worth trying again later; `busy` = the AI
 * service itself was overloaded/unavailable (not a problem with the file).
 */
export class EvidenceAnalyzerError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly busy = false,
  ) {
    super(message);
    this.name = 'EvidenceAnalyzerError';
  }
}
