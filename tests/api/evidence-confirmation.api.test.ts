import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeEvidenceAnalyzer } from '../support/fakes.js';
import { createOrg, type Org } from '../support/org.js';
import { FILES, lookupIds } from '../support/test-app.js';

/**
 * "Counts for the person, confirmed for compliance":
 *   flagged / unchecked evidence still completes the item, but dashboards and
 *   reports show confirmed separately; reminders chase rejections, never reviews;
 *   the Learning Team gets a Monday digest of evidence waiting > 5 days.
 */

let o: Org;
let ai: FakeEvidenceAnalyzer;
let aml: string;
let ack: string;
const ids: Record<string, string> = {};

const pdf = (marker: string) => Buffer.concat([FILES.pdf, Buffer.from(`\n% ${marker}\n`)]);
const submit = (who: { auth: string }, itemId: string, file?: Buffer) => {
  const req = request(o.t.app).put(`/api/v1/me/completions/${itemId}`).set('Authorization', who.auth).field('completedOn', '2026-02-11');
  if (file) req.attach('file', file, 'certificate.pdf');
  return req;
};
const overview = async (who: { auth: string }) => (await request(o.t.app).get('/api/v1/progress/overview').set('Authorization', who.auth)).body.data;

beforeAll(async () => {
  ai = new FakeEvidenceAnalyzer();
  o = await createOrg({ env: { AI_VERIFICATION_ENABLED: 'true', GEMINI_API_KEY: 'unused-with-fake' }, analyzer: ai });
  const lk = await lookupIds(o.t.db);
  const create = async (over: Record<string, unknown>) =>
    (
      await request(o.t.app)
        .post('/api/v1/items')
        .set('Authorization', o.amina.auth)
        .send({
          title: 'Item',
          provider: 'ICAEW',
          categoryId: lk.categories['Structured CPD'],
          cpdTypeId: lk.cpdTypes['Structured CPD'],
          deliveryTypeId: lk.deliveryTypes['eLearning'],
          hours: 2,
          isMandatory: true,
          evidenceMode: 'certificate',
          audience: { all: true },
          ...over,
        })
    ).body.data.id as string;
  aml = await create({ title: 'AML annual update', dueDate: '2026-12-31' });
  ack = await create({ title: 'Ethics briefing', evidenceMode: 'acknowledgement', isMandatory: false });

  // Sarah: verified by the AI. Tomas: flagged (someone else's name). Grace: acknowledgement only.
  ids.sarah = (await submit(o.sarah, aml, pdf('sarah'))).body.data.id;
  await o.t.container.verificationWorker.tick();
  ai.result = { checks: { name: 'mismatch', title: 'match', provider: 'match' } };
  ids.tomas = (await submit(o.tomas, aml, pdf('tomas'))).body.data.id;
  await o.t.container.verificationWorker.tick();
  ai.result = {};
  ids.grace = (await submit(o.grace, ack)).body.data.id;
});

afterAll(async () => {
  await o.t.close();
});

describe('staff plan', () => {
  it('counts flagged work as completed but not confirmed', async () => {
    const plan = (await request(o.t.app).get('/api/v1/me/plan').set('Authorization', o.tomas.auth)).body.data;
    const entry = plan.entries.find((e: { item: { id: string } }) => e.item.id === aml);
    expect(entry).toMatchObject({ status: 'completed', confirmed: false, completion: { reviewStatus: 'flagged' } });
    expect(plan.summary).toMatchObject({ completed: 1, confirmed: 0, underReview: 1 });
  });

  it('treats an acknowledgement as confirmed', async () => {
    const plan = (await request(o.t.app).get('/api/v1/me/plan').set('Authorization', o.grace.auth)).body.data;
    expect(plan.entries.find((e: { item: { id: string } }) => e.item.id === ack)).toMatchObject({ status: 'completed', confirmed: true });
  });
});

describe('dashboard', () => {
  it('shows done vs confirmed and the review queue', async () => {
    const d = await overview(o.amina);
    expect(d.kpis).toMatchObject({ confirmedCount: 2, underReviewCount: 1 });
    expect(d.items.find((r: { item: { id: string } }) => r.item.id === aml)).toMatchObject({ completedCount: 2, confirmedCount: 1 });
    expect(d.reviewQueue).toEqual({ waiting: 1, waitingOverDays: 0, overDays: 5 });
  });

  it('counts evidence as waiting too long after 5 days', async () => {
    await o.t.db.query(`update completions set submitted_at = '2026-09-01T10:00:00Z' where id = $1`, [ids.tomas]);
    expect((await overview(o.amina)).reviewQueue).toMatchObject({ waiting: 1, waitingOverDays: 1 });
  });

  it('scopes the queue to a manager’s own team', async () => {
    expect((await overview(o.priya)).reviewQueue.waiting).toBe(0); // Priya manages Grace only
  });
});

describe('reports', () => {
  const binary = (r: request.Test) =>
    r.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  const sheetRows = async (kind: string, sheet: string) => {
    const res = await binary(request(o.t.app).get(`/api/v1/reports/team/${kind}`).set('Authorization', o.amina.auth));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const rows: unknown[][] = [];
    wb.getWorksheet(sheet)!.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    return rows;
  };

  it('labels each completion Confirmed / Under review in the evidence register', async () => {
    const rows = await sheetRows('evidence', 'Evidence');
    expect(rows[0]).toEqual(expect.arrayContaining(['Evidence', 'Checked By', 'Review Notes']));
    const byName = Object.fromEntries(rows.slice(1).map((r) => [String(r[0]), r]));
    expect(byName['Sarah Whitfield']).toEqual(expect.arrayContaining(['Confirmed', 'Automatic check']));
    expect(byName['Tomas Neri']).toEqual(expect.arrayContaining(['Under review', 'Automatic check']));
    expect(byName.Grace ?? Object.entries(byName).find(([k]) => k.startsWith('Grace'))?.[1]).toEqual(
      expect.arrayContaining(['Confirmed', 'No file needed']),
    );
  });

  it('adds confirmed totals to the summary sheet and the ICAEW log', async () => {
    const summary = await sheetRows('completion', 'Summary');
    const head = summary.find((r) => r.includes('Confirmed %'))!;
    expect(head).toEqual(expect.arrayContaining(['Items Confirmed', 'Under Review', 'Hours Confirmed']));
    const icaew = await sheetRows('icaew', 'ICAEW CPD Log');
    expect(icaew[0]).toContain('Evidence Confirmed');
    expect(icaew.find((r) => r[0] === 'Tomas Neri')).toContain('Under review');
  });
});

describe('reminders', () => {
  const runOn = async (day: string) => {
    o.t.clock.todayValue = day;
    o.t.email.sent.length = 0;
    await o.t.container.services.reminders.runAutomatic();
    return o.t.email.sent;
  };

  beforeAll(async () => {
    await request(o.t.app).put('/api/v1/reminders/settings').set('Authorization', o.amina.auth).send({ autoEnabled: true });
  });
  afterAll(() => {
    o.t.clock.todayValue = '2026-09-10';
  });

  it('sends the Learning Team a digest on Monday, once', async () => {
    const sent = await runOn('2026-09-14'); // Monday
    const digests = sent.filter((m) => m.subject.includes('waiting for review'));
    expect(digests.map((m) => m.to)).toEqual(['apatel@pa.co.uk']);
    expect(digests[0]!.text).toContain('Tomas Neri - AML annual update - 13 days');
    // Nobody is chased for evidence that is only under review.
    expect(sent.some((m) => m.to === 'tneri@pa.co.uk')).toBe(false);

    const again = await runOn('2026-09-14'); // e.g. after a restart
    expect(again.filter((m) => m.subject.includes('waiting for review'))).toHaveLength(0);
  });

  it('sends no digest on other days', async () => {
    const sent = await runOn('2026-09-16'); // Wednesday
    expect(sent.filter((m) => m.subject.includes('waiting for review'))).toHaveLength(0);
  });

  it('reminds the person the morning after their evidence is rejected, with the reason', async () => {
    await request(o.t.app)
      .post(`/api/v1/completions/${ids.tomas}/review`)
      .set('Authorization', o.amina.auth)
      .send({ decision: 'rejected', note: 'The certificate shows someone else’s name.' });
    await o.t.db.query(`update completions set reviewed_at = '2026-09-17T15:00:00Z' where id = $1`, [ids.tomas]);

    const sent = await runOn('2026-09-18');
    const mail = sent.find((m) => m.to === 'tneri@pa.co.uk');
    expect(mail?.text).toContain('Evidence rejected: The certificate shows someone else’s name.');

    expect((await runOn('2026-09-19')).some((m) => m.to === 'tneri@pa.co.uk')).toBe(false); // not again
  });
});
