import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceAnalyzerError } from '../../src/application/ports/evidence-analyzer.js';
import { FakeEvidenceAnalyzer } from '../support/fakes.js';
import { createOrg, type Org } from '../support/org.js';
import { FILES, lookupIds } from '../support/test-app.js';

/** End-to-end: upload → queued check → worker → AI (fake) → policy → review state → Learning Team decision. */

let o: Org;
let ai: FakeEvidenceAnalyzer;
let aml: string;
let ifrs: string;
let ack: string;

const pdf = (marker: string) => Buffer.concat([FILES.pdf, Buffer.from(`\n% ${marker}\n`)]);

beforeAll(async () => {
  ai = new FakeEvidenceAnalyzer();
  o = await createOrg({ env: { AI_VERIFICATION_ENABLED: 'true', GEMINI_API_KEY: 'unused-with-fake', AI_MAX_ATTEMPTS: '4' }, analyzer: ai });
  const ids = await lookupIds(o.t.db);
  const create = async (over: Record<string, unknown>) => {
    const res = await request(o.t.app)
      .post('/api/v1/items')
      .set('Authorization', o.amina.auth)
      .send({
        title: 'Item',
        provider: 'ICAEW',
        categoryId: ids.categories['Structured CPD'],
        cpdTypeId: ids.cpdTypes['Structured CPD'],
        deliveryTypeId: ids.deliveryTypes['eLearning'],
        hours: 1.5,
        isMandatory: true,
        evidenceMode: 'certificate',
        audience: { all: true },
        ...over,
      });
    return res.body.data.id as string;
  };
  aml = await create({ title: 'AML annual update', dueDate: '2026-12-31' });
  ifrs = await create({ title: 'IFRS 16 leases', hours: 3 });
  ack = await create({ title: 'Ethics briefing', evidenceMode: 'acknowledgement' });
});

afterAll(async () => {
  await o.t.close();
});

beforeEach(() => {
  ai.calls.length = 0;
  ai.queue.length = 0;
  ai.result = {};
});

const submit = (who: { auth: string }, itemId: string, completedOn: string, file?: Buffer) => {
  const req = request(o.t.app).put(`/api/v1/me/completions/${itemId}`).set('Authorization', who.auth).field('completedOn', completedOn);
  if (file) req.attach('file', file, 'certificate.pdf');
  return req;
};
const work = () => o.t.container.verificationWorker.tick();
const myEntry = async (who: { auth: string }, itemId: string) => {
  const res = await request(o.t.app).get('/api/v1/me/plan').set('Authorization', who.auth);
  return (res.body.data.entries as { item: { id: string } }[]).find((e) => e.item.id === itemId) as Record<string, any>;
};
const checksOf = async (completionId: string) =>
  (await o.t.db.query<{ status: string }>('select status from evidence_checks where completion_id = $1 order by created_at', [completionId])).rows.map((r) => r.status);

describe('automatic evidence verification', () => {
  it('queues a check on upload and answers immediately', async () => {
    const res = await submit(o.sarah, aml, '2026-02-11', pdf('sarah-aml'));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ reviewStatus: 'not_reviewed', check: { status: 'queued' } });
    expect(ai.calls).toHaveLength(0); // the request never waits on the AI
  });

  it('verifies a matching certificate in the background (source ai)', async () => {
    expect(await work()).toBe(1);
    expect(ai.calls[0]).toMatchObject({
      mimeType: 'application/pdf',
      expected: { personName: 'Sarah Whitfield', itemTitle: 'AML annual update', hours: 1.5, completedOn: '2026-02-11', provider: 'ICAEW' },
    });
    const entry = await myEntry(o.sarah, aml);
    expect(entry.status).toBe('completed');
    expect(entry.completion).toMatchObject({
      reviewStatus: 'verified',
      reviewSource: 'ai',
      reviewNotes: null,
      check: { status: 'done', decision: 'verified', confidence: null, model: null }, // details are reviewer-only
    });
    const row = await o.t.db.query<{ input_tokens: number }>('select input_tokens from evidence_checks');
    expect(row.rows[0]!.input_tokens).toBe(1000);
  });

  it('flags a certificate for a different course, with the reason', async () => {
    ai.result = { checks: { name: 'match', title: 'mismatch', provider: 'match' }, extracted: { participantName: 'Tomas Neri', courseTitle: 'Excel for beginners', provider: 'ICAEW', completionDate: '2026-02-01', hours: 3, certificateId: null } };
    await submit(o.tomas, ifrs, '2026-02-02', pdf('tomas-excel'));
    await work();
    const entry = await myEntry(o.tomas, ifrs);
    expect(entry.status).toBe('completed'); // flagged still counts until a person rejects it
    expect(entry.completion).toMatchObject({ reviewStatus: 'flagged', reviewSource: 'ai' });
    expect(entry.completion.reviewNotes).toMatch(/Excel for beginners/);
  });

  it('flags the same file submitted by someone else', async () => {
    await submit(o.grace, aml, '2026-02-11', pdf('sarah-aml'));
    await work();
    const entry = await myEntry(o.grace, aml);
    expect(entry.completion.reviewStatus).toBe('flagged');
    expect(entry.completion.reviewNotes).toMatch(/already submitted/);
  });

  it('does not run checks for acknowledgement items without a file', async () => {
    const res = await submit(o.sarah, ack, '2026-03-01');
    expect(res.body.data.check).toBeNull();
    expect(await work()).toBe(0);
  });

  it('retries temporary failures, then hands over to a person', async () => {
    ai.queue.push(new EvidenceAnalyzerError('rate limited', true));
    const res = await submit(o.ibraaheem, aml, '2026-02-11', pdf('ibra-1'));
    const id = res.body.data.id as string;
    expect(await work()).toBe(1);
    expect(await checksOf(id)).toEqual(['queued']); // waiting for the retry

    await o.t.db.query(`update evidence_checks set next_attempt_at = now() where completion_id = $1`, [id]);
    ai.queue.push(new EvidenceAnalyzerError('bad request', false)); // permanent
    await work();
    expect(await checksOf(id)).toEqual(['failed']);
    const entry = await myEntry(o.ibraaheem, aml);
    expect(entry.completion).toMatchObject({ reviewStatus: 'flagged', reviewSource: 'ai' });
    expect(entry.completion.reviewNotes).toMatch(/review this evidence manually/);
  });

  it('hands over with a "service busy" note when the AI stays unavailable', async () => {
    const res = await submit(o.priya, aml, '2026-02-11', pdf('priya-1'));
    const id = res.body.data.id as string;
    for (let i = 0; i < 4; i++) {
      ai.queue.push(new EvidenceAnalyzerError('Gemini API error 503: high demand', true, true));
      await o.t.db.query(`update evidence_checks set next_attempt_at = now() where completion_id = $1`, [id]);
      await work();
    }
    expect(await checksOf(id)).toEqual(['failed']);
    const entry = await myEntry(o.priya, aml);
    expect(entry.completion).toMatchObject({ reviewStatus: 'flagged', reviewSource: 'ai' });
    expect(entry.completion.reviewNotes).toMatch(/service was unavailable/);
  });

  it('supersedes the old check when the file is replaced', async () => {
    const first = await submit(o.daniel, aml, '2026-02-11', pdf('daniel-1'));
    await submit(o.daniel, aml, '2026-02-12', pdf('daniel-2'));
    expect(await checksOf(first.body.data.id)).toEqual(['superseded', 'queued']);
    expect(await work()).toBe(1);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.expected.completedOn).toBe('2026-02-12');
  });
});

describe('Learning Team decisions', () => {
  const register = async () =>
    (await request(o.t.app).get('/api/v1/completions').set('Authorization', o.amina.auth)).body.data as Record<string, any>[];
  const decide = (who: { auth: string }, id: string, body: Record<string, unknown>) =>
    request(o.t.app).post(`/api/v1/completions/${id}/review`).set('Authorization', who.auth).send(body);

  it('shows reviewers the AI findings in the register', async () => {
    const flagged = (await register()).find((r) => r.person.fullName === 'Tomas Neri' && r.item.title === 'IFRS 16 leases')!;
    expect(flagged.completion.check).toMatchObject({
      decision: 'flagged',
      extracted: { courseTitle: 'Excel for beginners' },
      checks: { title: 'mismatch' },
    });
  });

  it('only the Learning Team may decide; HR and managers are read-only', async () => {
    const id = (await register())[0]!.completion.id as string;
    expect((await decide(o.elena, id, { decision: 'verified' })).status).toBe(403);
    expect((await decide(o.daniel, id, { decision: 'verified' })).status).toBe(403);
    expect((await request(o.t.app).post(`/api/v1/completions/${id}/recheck`).set('Authorization', o.elena.auth)).status).toBe(403);
  });

  it('requires a reason to reject; a rejection makes the item outstanding again', async () => {
    const row = (await register()).find((r) => r.person.fullName === 'Tomas Neri' && r.item.title === 'IFRS 16 leases')!;
    const noReason = await decide(o.amina, row.completion.id, { decision: 'rejected' });
    expect(noReason.body.code).toBe('REJECTION_REASON_REQUIRED');

    const res = await decide(o.amina, row.completion.id, { decision: 'rejected', note: 'This certificate is for a different course.' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reviewStatus: 'rejected', reviewSource: 'manual', reviewNotes: 'This certificate is for a different course.' });

    const entry = await myEntry(o.tomas, ifrs);
    expect(entry.status).not.toBe('completed');
    expect(entry.completion).toBeNull();
    expect(entry.rejected).toMatchObject({ reviewStatus: 'rejected', reviewNotes: 'This certificate is for a different course.' });

    const audit = await o.t.db.query(`select 1 from audit_events where action = 'evidence.rejected' and entity_id = $1`, [row.completion.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('the AI never overrides a person: a re-check keeps the manual decision', async () => {
    const row = (await register()).find((r) => r.person.fullName === 'Grace' || r.person.fullName.startsWith('Grace'))!;
    await decide(o.amina, row.completion.id, { decision: 'verified', note: 'Same certificate, checked with the provider.' });
    const re = await request(o.t.app).post(`/api/v1/completions/${row.completion.id}/recheck`).set('Authorization', o.amina.auth);
    expect(re.status).toBe(202);
    expect(re.body.data.check.status).toBe('queued');
    await work();
    const after = (await register()).find((r) => r.completion.id === row.completion.id)!;
    expect(after.completion).toMatchObject({ reviewStatus: 'verified', reviewSource: 'manual', check: { status: 'done', decision: 'flagged' } });
  });

  it('a rejection cannot be undone by re-submitting without a new file, or with the same file', async () => {
    const noFile = await submit(o.tomas, ifrs, '2026-02-03');
    expect(noFile.status).toBe(422);
    expect(noFile.body.code).toBe('EVIDENCE_REJECTED');
    const sameFile = await submit(o.tomas, ifrs, '2026-02-03', pdf('tomas-excel'));
    expect(sameFile.body.code).toBe('EVIDENCE_REJECTED');
    expect((await myEntry(o.tomas, ifrs)).rejected).not.toBeNull(); // still rejected
  });

  it("shows staff the outcome but not the AI's detailed findings", async () => {
    const mine = (await myEntry(o.tomas, ifrs)).rejected;
    expect(mine.reviewNotes).toBeTruthy();
    expect(mine.check).toMatchObject({ status: 'done', decision: 'flagged', extracted: null, checks: null, confidence: null, summary: null, tamperingSigns: [] });
    const staffList = (await request(o.t.app).get('/api/v1/me/completions').set('Authorization', o.sarah.auth)).body.data as Record<string, any>[];
    expect(staffList[0]!.completion.check.extracted).toBeNull();
    // Reviewers still get everything.
    const row = (await register()).find((r) => r.person.fullName === 'Tomas Neri' && r.item.title === 'IFRS 16 leases')!;
    expect(row.completion.check.extracted).toMatchObject({ courseTitle: 'Excel for beginners' });
  });

  it('re-uploading after a rejection starts a fresh check', async () => {
    ai.result = {};
    const res = await submit(o.tomas, ifrs, '2026-02-02', pdf('tomas-ifrs-real'));
    expect(res.body.data).toMatchObject({ reviewStatus: 'not_reviewed', reviewSource: null, check: { status: 'queued' } });
    await work();
    const entry = await myEntry(o.tomas, ifrs);
    expect(entry.status).toBe('completed');
    expect(entry.completion.reviewStatus).toBe('verified');
  });
});
