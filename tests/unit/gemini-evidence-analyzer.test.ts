import { ApiError } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceAnalyzerError } from '../../src/application/ports/evidence-analyzer.js';
import { retryDelayMs } from '../../src/application/use-cases/evidence-verification.service.js';
import { GeminiEvidenceAnalyzer } from '../../src/infrastructure/external-services/gemini-evidence-analyzer.js';

const expected = {
  personName: 'Sarah Whitfield',
  itemTitle: 'AML annual update',
  itemDescription: null,
  provider: 'ICAEW',
  hours: 1.5,
  completedOn: '2026-02-11',
  category: 'Mandatory Compliance',
  deliveryType: 'eLearning',
};

const answer = {
  isCertificate: true,
  documentType: 'Certificate',
  extracted: { participantName: 'Sarah Whitfield', courseTitle: 'AML', provider: 'ICAEW', completionDate: '2026-02-10', hours: 1.5, certificateId: null },
  checks: { name: 'match', title: 'match', provider: 'match' },
  tamperingSigns: [],
  confidence: 0.9,
  summary: 'ok',
};

const busy = () => new ApiError({ message: 'This model is currently experiencing high demand.', status: 503 });

/** Analyzer with the SDK call stubbed (no network). */
function analyzerWith(impl: (req: { model: string }) => Promise<unknown>, models = ['main-model', 'backup-model']) {
  const a = new GeminiEvidenceAnalyzer('test-key', models);
  const generate = vi.fn(impl);
  (a as unknown as { ai: { models: { generateContent: unknown } } }).ai.models.generateContent = generate;
  return { a, generate };
}

const ok = { text: JSON.stringify(answer), usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 150 } };
const input = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf', expected };

describe('GeminiEvidenceAnalyzer', () => {
  it('uses the main model when it answers', async () => {
    const { a, generate } = analyzerWith(async () => ok);
    const out = await a.analyze(input);
    expect(out).toMatchObject({ provider: 'gemini', model: 'main-model', inputTokens: 1200, outputTokens: 150 });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('falls back to the next model straight away when the main one is overloaded (503)', async () => {
    const { a, generate } = analyzerWith(async ({ model }) => {
      if (model === 'main-model') throw busy();
      return ok;
    });
    const out = await a.analyze(input);
    expect(out.model).toBe('backup-model');
    expect(generate.mock.calls.map(([r]) => r.model)).toEqual(['main-model', 'backup-model']);
  });

  it('reports "busy, try later" when every model is overloaded', async () => {
    const { a } = analyzerWith(async () => {
      throw busy();
    });
    const err = (await a.analyze(input).catch((e: unknown) => e)) as EvidenceAnalyzerError;
    expect(err).toBeInstanceOf(EvidenceAnalyzerError);
    expect(err).toMatchObject({ retryable: true, busy: true });
  });

  it('does not try other models for a request problem (400)', async () => {
    const { a, generate } = analyzerWith(async () => {
      throw new ApiError({ message: 'Invalid argument', status: 400 });
    });
    const err = (await a.analyze(input).catch((e: unknown) => e)) as EvidenceAnalyzerError;
    expect(err).toMatchObject({ retryable: false, busy: false });
    expect(generate).toHaveBeenCalledOnce();
  });
});

describe('retryDelayMs', () => {
  it('backs off over about an hour and a half, with jitter', () => {
    const mid = () => 0.5; // no jitter
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => retryDelayMs(n, mid) / 60_000)).toEqual([1, 3, 10, 20, 30, 30, 30]);
    expect(retryDelayMs(1, () => 0)).toBe(48_000);
    expect(retryDelayMs(1, () => 1)).toBe(72_000);
  });
});
