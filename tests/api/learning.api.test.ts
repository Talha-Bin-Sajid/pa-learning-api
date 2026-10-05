import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg, type Org } from '../support/org.js';
import { FILES, lookupIds } from '../support/test-app.js';

let o: Org;
let aml: string; // everyone, mandatory, due 2026-03-31 (overdue on 2026-09-10)
let ethicsAck: string; // everyone, acknowledgement, due 2026-12-31
let ifrs: string; // Senior Accountant only

beforeAll(async () => {
  o = await createOrg();
  const ids = await lookupIds(o.t.db);
  const create = async (over: Record<string, unknown>) => {
    const res = await request(o.t.app)
      .post('/api/v1/items')
      .set('Authorization', o.amina.auth)
      .send({
        title: 'Item',
        categoryId: ids.categories['Structured CPD'],
        cpdTypeId: ids.cpdTypes['Structured CPD'],
        deliveryTypeId: ids.deliveryTypes['eLearning'],
        hours: 1,
        isMandatory: false,
        evidenceMode: 'certificate',
        audience: { all: true },
        ...over,
      });
    return res.body.data.id as string;
  };
  aml = await create({ title: 'AML', hours: 1.5, dueDate: '2026-03-31', isMandatory: true, categoryId: ids.categories['Mandatory Compliance'] });
  ethicsAck = await create({ title: 'Ethics briefing', hours: 1, dueDate: '2026-12-31', evidenceMode: 'acknowledgement', categoryId: ids.categories['Ethics'] });
  ifrs = await create({ title: 'IFRS 16', hours: 3, audience: { all: false, designationIds: [ids.designations['Senior Accountant']] } });
});

afterAll(async () => {
  await o.t.close();
});

const submit = (who: { auth: string }, itemId: string, fields: Record<string, string>, file?: { buf: Buffer; name: string }) => {
  const req = request(o.t.app).put(`/api/v1/me/completions/${itemId}`).set('Authorization', who.auth);
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  if (file) req.attach('file', file.buf, file.name);
  return req;
};

describe('submitting evidence', () => {
  it('requires a file for certificate items', async () => {
    const res = await submit(o.sarah, aml, { completedOn: '2026-02-11' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EVIDENCE_REQUIRED');
  });

  it('checks the real file type, not the extension', async () => {
    const res = await submit(o.sarah, aml, { completedOn: '2026-02-11' }, { buf: FILES.exeRenamed, name: 'certificate.pdf' });
    expect(res.status).toBe(415);
    expect(o.t.storage.objects.size).toBe(0);
  });

  it('rejects future and pre-programme completion dates', async () => {
    const future = await submit(o.sarah, aml, { completedOn: '2026-09-11' }, { buf: FILES.pdf, name: 'c.pdf' });
    expect(future.body.code).toBe('COMPLETION_IN_FUTURE');
    const early = await submit(o.sarah, aml, { completedOn: '2025-12-31' }, { buf: FILES.pdf, name: 'c.pdf' });
    expect(early.body.code).toBe('COMPLETION_BEFORE_CYCLE');
  });

  it('stores the file privately and records the completion (201)', async () => {
    const res = await submit(o.sarah, aml, { completedOn: '2026-02-11', reflection: 'Applied the red-flag checklist.' }, { buf: FILES.pdf, name: '../../aml-certificate.pdf' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      completedOn: '2026-02-11',
      reflection: 'Applied the red-flag checklist.',
      evidence: { fileName: 'aml-certificate.pdf', mimeType: 'application/pdf' },
      reviewStatus: 'not_reviewed',
    });
    const [path] = [...o.t.storage.objects.keys()];
    expect(path).toMatch(new RegExp(`^2026/${o.sarah.id}/${aml}/[0-9a-f-]+\\.pdf$`));
  });

  it('replaces evidence (200) and deletes the old file', async () => {
    const before = [...o.t.storage.objects.keys()];
    const res = await submit(o.sarah, aml, { completedOn: '2026-02-12' }, { buf: FILES.png, name: 'screenshot.png' });
    expect(res.status).toBe(200);
    expect(res.body.data.evidence.mimeType).toBe('image/png');
    const after = [...o.t.storage.objects.keys()];
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
  });

  it('completes acknowledgement items without a file', async () => {
    const res = await submit(o.sarah, ethicsAck, { completedOn: '2026-09-01' });
    expect(res.status).toBe(201);
    expect(res.body.data.evidence).toBeNull();
  });

  it('hides items outside your plan (404, not 403)', async () => {
    const res = await submit(o.sarah, ifrs, { completedOn: '2026-02-11' }, { buf: FILES.pdf, name: 'c.pdf' });
    expect(res.status).toBe(404);
  });

  it('rejects files over 15 MB before reading them fully', async () => {
    const big = Buffer.alloc(15 * 1024 * 1024 + 10, 0x25);
    const res = await submit(o.tomas, aml, { completedOn: '2026-02-11' }, { buf: big, name: 'big.pdf' });
    expect(res.status).toBe(413);
  });
});

describe('my plan', () => {
  it('shows statuses, hours-weighted progress and CPD hours by category', async () => {
    const res = await request(o.t.app).get('/api/v1/me/plan').set('Authorization', o.sarah.auth);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.entries.map((e: { item: { title: string }; status: string }) => [e.item.title, e.status])).toEqual([
      ['AML', 'completed'],
      ['Ethics briefing', 'completed'],
    ]);
    expect(d.summary).toMatchObject({ assigned: 2, completed: 2, hoursAssigned: 2.5, completionPct: 100 });
    expect(d.hoursByCategory).toEqual(expect.arrayContaining([{ category: 'Mandatory Compliance', hours: 1.5 }]));
  });

  it('marks overdue items for someone who has not done them', async () => {
    const res = await request(o.t.app).get('/api/v1/me/plan').set('Authorization', o.tomas.auth);
    const amlEntry = res.body.data.entries.find((e: { item: { title: string } }) => e.item.title === 'AML');
    expect(amlEntry).toMatchObject({ status: 'overdue', daysOverdue: 163 });
  });
});

describe('visibility scoping', () => {
  it('Learning Team sees everyone with learning assigned', async () => {
    const res = await request(o.t.app).get('/api/v1/progress/members').set('Authorization', o.amina.auth);
    expect(res.body.data).toHaveLength(8); // all roles count (decision D4)
  });

  it("a manager without full access sees only their direct reports", async () => {
    const res = await request(o.t.app).get('/api/v1/progress/members').set('Authorization', o.priya.auth);
    expect(res.body.data.map((m: { person: { fullName: string } }) => m.person.fullName)).toEqual(['Grace Lin']);
  });

  it("a manager cannot open another team's member (404)", async () => {
    const res = await request(o.t.app).get(`/api/v1/progress/members/${o.sarah.id}`).set('Authorization', o.priya.auth);
    expect(res.status).toBe(404);
    const own = await request(o.t.app).get(`/api/v1/progress/members/${o.grace.id}`).set('Authorization', o.priya.auth);
    expect(own.status).toBe(200);
  });

  it('team members cannot use team endpoints', async () => {
    expect((await request(o.t.app).get('/api/v1/progress/overview').set('Authorization', o.sarah.auth)).status).toBe(403);
    expect((await request(o.t.app).get(`/api/v1/progress/members/${o.tomas.id}`).set('Authorization', o.sarah.auth)).status).toBe(404);
  });

  it('dashboard overview is scoped and counts evidence per month', async () => {
    const res = await request(o.t.app).get('/api/v1/progress/overview').set('Authorization', o.amina.auth);
    const d = res.body.data;
    expect(d.kpis).toMatchObject({ itemCount: 3, mandatoryItemCount: 1, memberCount: 8, evidenceCount: 2 });
    expect(d.evidenceByMonth.find((m: { month: string }) => m.month === '2026-02').count).toBe(1);
    expect(d.items.find((i: { item: { title: string } }) => i.item.title === 'IFRS 16')).toMatchObject({ assignedCount: 1, completedCount: 0 });

    const priya = await request(o.t.app).get('/api/v1/progress/overview').set('Authorization', o.priya.auth);
    expect(priya.body.data).toMatchObject({ scope: 'team', kpis: { memberCount: 1, evidenceCount: 0 } });
  });
});

describe('evidence access', () => {
  let completionId: string;

  beforeAll(async () => {
    const mine = await request(o.t.app).get('/api/v1/me/completions').set('Authorization', o.sarah.auth);
    completionId = mine.body.data[0].completion.id;
  });

  it('gives the owner, their manager and admins a short-lived link', async () => {
    for (const who of [o.sarah, o.daniel, o.amina, o.elena]) {
      const res = await request(o.t.app).get(`/api/v1/completions/${completionId}/evidence-url`).set('Authorization', who.auth);
      expect(res.status).toBe(200);
      expect(res.body.data.url).toContain('expires=300');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('refuses colleagues and other managers (404)', async () => {
    for (const who of [o.tomas, o.priya]) {
      const res = await request(o.t.app).get(`/api/v1/completions/${completionId}/evidence-url`).set('Authorization', who.auth);
      expect(res.status).toBe(404);
    }
  });

  it('Evidence Review register is for the Learning Team and HR only', async () => {
    const res = await request(o.t.app).get('/api/v1/completions').set('Authorization', o.elena.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect((await request(o.t.app).get('/api/v1/completions').set('Authorization', o.daniel.auth)).status).toBe(403);
  });

  it('keeps completions of archived items in history', async () => {
    await request(o.t.app).delete(`/api/v1/items/${aml}`).set('Authorization', o.amina.auth);
    const reg = await request(o.t.app).get('/api/v1/completions').set('Authorization', o.amina.auth);
    expect(reg.body.data.find((r: { item: { title: string } }) => r.item.title === 'AML').item.archived).toBe(true);
    const plan = await request(o.t.app).get('/api/v1/me/plan').set('Authorization', o.tomas.auth);
    expect(plan.body.data.entries.map((e: { item: { title: string } }) => e.item.title)).not.toContain('AML');
  });
});
