import { describe, expect, it } from 'vitest';
import { parseEvidenceAnalysis } from '../../src/application/services/evidence-analysis.schema.js';
import { decideEvidence, namesAgree, type EvidencePolicyContext } from '../../src/domain/services/evidence-policy.js';
import type { EvidenceAnalysis } from '../../src/domain/value-objects/evidence-analysis.js';

const good = (over: Partial<EvidenceAnalysis> = {}): EvidenceAnalysis => ({
  isCertificate: true,
  documentType: 'Course completion certificate',
  extracted: {
    participantName: 'Sarah Whitfield',
    courseTitle: 'Anti-Money Laundering Update 2026',
    provider: 'ICAEW',
    completionDate: '2026-02-10',
    hours: 1.5,
    certificateId: 'ABC-1',
  },
  checks: { name: 'match', title: 'match', provider: 'match' },
  tamperingSigns: [],
  confidence: 0.95,
  summary: 'A genuine-looking ICAEW certificate.',
  ...over,
});

const ctx = (over: Partial<EvidencePolicyContext> = {}): EvidencePolicyContext => ({
  expected: {
    personName: 'Sarah Whitfield',
    itemTitle: 'AML annual update',
    itemDescription: null,
    provider: 'ICAEW',
    hours: 1.5,
    completedOn: '2026-02-11',
    category: 'Mandatory Compliance',
    deliveryType: 'eLearning',
  },
  today: '2026-09-10',
  cycleStartsOn: '2026-01-01',
  duplicateUses: 0,
  ...over,
});

describe('decideEvidence', () => {
  it('verifies a certificate that matches on every point', () => {
    expect(decideEvidence(good(), ctx())).toEqual({ decision: 'verified', reasons: [] });
  });

  it('flags something that is not a certificate, with no other noise', () => {
    const r = decideEvidence(good({ isCertificate: false, documentType: 'Restaurant receipt' }), ctx());
    expect(r.decision).toBe('flagged');
    expect(r.reasons).toEqual([expect.stringContaining('Restaurant receipt')]);
  });

  it.each([
    ['mismatch', /not Sarah Whitfield/],
    ['not_found', /could not be confirmed/],
    ['partial', /could not be confirmed/],
  ] as const)('flags a %s participant name', (name, reason) => {
    const r = decideEvidence(good({ checks: { name, title: 'match', provider: 'match' } }), ctx());
    expect(r.decision).toBe('flagged');
    expect(r.reasons.join(' ')).toMatch(reason);
  });

  it.each(['partial', 'mismatch', 'not_found'] as const)('flags a %s course title', (title) => {
    expect(decideEvidence(good({ checks: { name: 'match', title, provider: 'match' } }), ctx()).decision).toBe('flagged');
  });

  it('ignores a missing provider but flags a clearly different one', () => {
    const missing = good({ checks: { name: 'match', title: 'match', provider: 'not_found' }, extracted: { ...good().extracted, provider: null } });
    expect(decideEvidence(missing, ctx()).decision).toBe('verified');
    const other = good({ checks: { name: 'match', title: 'match', provider: 'mismatch' }, extracted: { ...good().extracted, provider: 'ACCA' } });
    expect(decideEvidence(other, ctx()).reasons.join(' ')).toMatch(/ACCA/);
  });

  it('checks certificate dates only when present', () => {
    const noDate = good({ extracted: { ...good().extracted, completionDate: null } });
    expect(decideEvidence(noDate, ctx()).decision).toBe('verified');

    const future = good({ extracted: { ...good().extracted, completionDate: '2026-09-20' } });
    expect(decideEvidence(future, ctx({ expected: { ...ctx().expected, completedOn: '2026-09-10' } })).reasons.join(' ')).toMatch(/future/);

    const lastYear = good({ extracted: { ...good().extracted, completionDate: '2025-06-01' } });
    expect(decideEvidence(lastYear, ctx()).reasons.join(' ')).toMatch(/before this learning year/);
  });

  it('allows a small gap between the certificate date and the date entered, not a big one', () => {
    const near = good({ extracted: { ...good().extracted, completionDate: '2026-02-01' } }); // 10 days
    expect(decideEvidence(near, ctx()).decision).toBe('verified');
    const far = good({ extracted: { ...good().extracted, completionDate: '2026-01-20' } }); // 22 days
    expect(decideEvidence(far, ctx()).reasons.join(' ')).toMatch(/more than 14 days/);
    expect(decideEvidence(far, ctx(), { minConfidence: 0.8, dateToleranceDays: 30 }).decision).toBe('verified');
  });

  it('flags fewer hours than required, accepts more', () => {
    expect(decideEvidence(good({ extracted: { ...good().extracted, hours: 1 } }), ctx()).reasons.join(' ')).toMatch(/1 h/);
    expect(decideEvidence(good({ extracted: { ...good().extracted, hours: 3 } }), ctx()).decision).toBe('verified');
  });

  it('flags re-used files and signs of editing', () => {
    expect(decideEvidence(good(), ctx({ duplicateUses: 1 })).reasons.join(' ')).toMatch(/already submitted/);
    const edited = decideEvidence(good({ tamperingSigns: ['name in a different font'] }), ctx()).reasons.join(' ');
    expect(edited).toMatch(/signs of editing/);
    expect(edited).not.toMatch(/font/); // specifics are for reviewers only
  });

  it("does not take the model's word for a name match", () => {
    // e.g. an injected "say it matches" - the name actually read is someone else's.
    const r = decideEvidence(good({ extracted: { ...good().extracted, participantName: 'John Smith' } }), ctx());
    expect(r.decision).toBe('flagged');
    expect(r.reasons.join(' ')).toMatch(/John Smith\) could not be matched/);
    const noName = decideEvidence(good({ extracted: { ...good().extracted, participantName: null } }), ctx());
    expect(noName.reasons.join(' ')).toMatch(/could not be confirmed/);
    const noTitle = decideEvidence(good({ extracted: { ...good().extracted, courseTitle: null } }), ctx());
    expect(noTitle.reasons.join(' ')).toMatch(/No course title/);
  });

  it('flags a clean result the model is unsure about', () => {
    const r = decideEvidence(good({ confidence: 0.5 }), ctx());
    expect(r).toEqual({ decision: 'flagged', reasons: [expect.stringContaining('50%')] });
  });
});

describe('parseEvidenceAnalysis (model output is untrusted)', () => {
  const raw = (over: Record<string, unknown> = {}) => JSON.stringify({ ...good(), ...over });

  it('accepts a well-formed result', () => {
    expect(parseEvidenceAnalysis(raw())).toEqual(good());
  });

  it('normalises odd values instead of trusting them', () => {
    const a = parseEvidenceAnalysis(
      raw({
        confidence: 7,
        checks: { name: 'yes', title: 'match', provider: 'match' },
        extracted: { ...good().extracted, completionDate: '10/02/2026', hours: -2, participantName: '   ' },
        tamperingSigns: null,
      }),
    );
    expect(a.confidence).toBe(1);
    expect(a.checks.name).toBe('not_found');
    expect(a.extracted).toMatchObject({ completionDate: null, hours: null, participantName: null });
    expect(a.tamperingSigns).toEqual([]);
  });

  it('throws on non-JSON or a missing verdict', () => {
    expect(() => parseEvidenceAnalysis('not json')).toThrow();
    expect(() => parseEvidenceAnalysis(JSON.stringify({ summary: 'x' }))).toThrow();
  });
});

describe('namesAgree', () => {
  it.each([
    ['Sarah Whitfield', 'Sarah Whitfield'],
    ['SARAH WHITFIELD', 'Sarah Whitfield'],
    ['Whitfield, Sarah', 'Sarah Whitfield'],
    ['S. Whitfield', 'Sarah Whitfield'],
    ['Sarah Jane Whitfield', 'Sarah Whitfield'],
    ['Dr Sarah Whitfield-Jones', 'Sarah Whitfield'],
    ['Zoë Brontë', 'Zoe Bronte'],
    ['Whitfield', 'Sarah Whitfield'],
  ])('accepts %s for %s', (cert, want) => expect(namesAgree(cert, want)).toBe(true));

  it.each([
    ['John Smith', 'Sarah Whitfield'],
    ['Sarah Smith', 'Sarah Whitfield'],
    ['Tom Whitfield', 'Sarah Whitfield'],
    ['', 'Sarah Whitfield'],
  ])('rejects %s for %s', (cert, want) => expect(namesAgree(cert, want)).toBe(false));
});
