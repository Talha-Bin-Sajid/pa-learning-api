import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localTime, ReminderScheduler } from '../../src/infrastructure/external-services/reminder-scheduler.js';
import { PgReminderRepository } from '../../src/infrastructure/repositories/pg-reminder-repository.js';
import { silentLogger } from '../../src/shared/utils/logger.js';
import { createOrg, type Org } from '../support/org.js';
import { FILES, lookupIds } from '../support/test-app.js';

let o: Org;

beforeAll(async () => {
  o = await createOrg();
  const ids = await lookupIds(o.t.db);
  const create = (over: Record<string, unknown>) =>
    request(o.t.app)
      .post('/api/v1/items')
      .set('Authorization', o.amina.auth)
      .send({
        title: 'Item',
        categoryId: ids.categories['Structured CPD'],
        cpdTypeId: ids.cpdTypes['Structured CPD'],
        deliveryTypeId: ids.deliveryTypes['Webinar'],
        hours: 2,
        isMandatory: false,
        evidenceMode: 'certificate',
        audience: { all: true },
        ...over,
      });
  // Today is 2026-09-10 (FixedClock).
  const overdue = await create({ title: 'GDPR', dueDate: '2026-09-09', isMandatory: true }); // overdue by 1 day → trigger
  await create({ title: 'Client Conversations', dueDate: '2026-09-24' }); // due in 14 → trigger
  // Sarah has done GDPR.
  await request(o.t.app)
    .put(`/api/v1/me/completions/${overdue.body.data.id}`)
    .set('Authorization', o.sarah.auth)
    .field('completedOn', '2026-09-01')
    .field('reflection', 'Applied retention rules')
    .attach('file', FILES.pdf, 'gdpr.pdf');
});

afterAll(async () => {
  await o.t.close();
});

describe('reminder settings', () => {
  it('reads and saves settings (admin only)', async () => {
    const get = await request(o.t.app).get('/api/v1/reminders/settings').set('Authorization', o.amina.auth);
    expect(get.body.data).toMatchObject({ autoEnabled: true, leadDays: [30, 14, 7], overdueFrequency: 'weekly', sendTime: '09:00', ccLineManager: 'overdue' });

    const put = await request(o.t.app)
      .put('/api/v1/reminders/settings')
      .set('Authorization', o.amina.auth)
      .send({ leadDays: [7, 14, 14], sendTime: '08:00' });
    expect(put.body.data).toMatchObject({ leadDays: [14, 7], sendTime: '08:00' });

    const bad = await request(o.t.app).put('/api/v1/reminders/settings').set('Authorization', o.amina.auth).send({ sendTime: '25:00' });
    expect(bad.status).toBe(400);
    expect((await request(o.t.app).get('/api/v1/reminders/settings').set('Authorization', o.elena.auth)).status).toBe(403);

    await request(o.t.app).put('/api/v1/reminders/settings').set('Authorization', o.amina.auth).send({ leadDays: [30, 14, 7], sendTime: '09:00' });
  });
});

describe('manual reminders', () => {
  it('lists people with outstanding learning, overdue first', async () => {
    const res = await request(o.t.app).get('/api/v1/reminders/candidates').set('Authorization', o.amina.auth);
    expect(res.body.data[0]).toMatchObject({ overdueCount: 1 });
    const sarah = res.body.data.find((c: { person: { fullName: string } }) => c.person.fullName === 'Sarah Whitfield');
    expect(sarah).toMatchObject({ outstandingCount: 1, overdueCount: 0 });
  });

  it('sends one email per person, CCs the line manager when overdue, and logs it', async () => {
    o.t.email.sent.length = 0;
    const res = await request(o.t.app)
      .post('/api/v1/reminders/send')
      .set('Authorization', o.amina.auth)
      .send({ profileIds: [o.tomas.id, o.sarah.id], message: 'Please finish by Friday <b>thanks</b>' });
    expect(res.body.data).toEqual({ sent: 2, failed: 0, skipped: 0 });
    const tomasMail = o.t.email.sent.find((m) => m.to === 'tneri@pa.co.uk')!;
    expect(tomasMail.cc).toEqual(['dokoro@pa.co.uk']); // overdue → CC Daniel
    expect(tomasMail.subject).toMatch(/1 overdue/);
    expect(tomasMail.html).toContain('&lt;b&gt;thanks&lt;/b&gt;'); // escaped
    expect(o.t.email.sent.find((m) => m.to === 'swhitfield@pa.co.uk')!.cc).toEqual([]); // nothing overdue

    const log = await request(o.t.app).get('/api/v1/reminders/log').set('Authorization', o.amina.auth);
    expect(log.body.data[0]).toMatchObject({ kind: 'manual', sentBy: 'Amina Patel', hasNote: true, deliveryStatus: 'sent' });
  });

  it('records failed deliveries', async () => {
    o.t.email.failFor.add('glin@pa.co.uk');
    const res = await request(o.t.app).post('/api/v1/reminders/send').set('Authorization', o.amina.auth).send({ profileIds: [o.grace.id] });
    expect(res.body.data).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const log = await request(o.t.app).get('/api/v1/reminders/log').set('Authorization', o.amina.auth);
    expect(log.body.data[0]).toMatchObject({ deliveryStatus: 'failed' });
    o.t.email.failFor.clear();
  });
});

describe('automatic reminders', () => {
  it('sends to everyone with a trigger today, exactly once per day', async () => {
    o.t.email.sent.length = 0;
    const first = await o.t.container.services.reminders.runAutomatic();
    expect(first.sent).toBe(8); // all 8 people have "Client Conversations" due in 14 days
    const again = await o.t.container.services.reminders.runAutomatic();
    expect(again).toEqual({ sent: 0, failed: 0, skipped: 8 });
    expect(o.t.email.sent).toHaveLength(8);
  });

  it('sends nothing when switched off', async () => {
    await request(o.t.app).put('/api/v1/reminders/settings').set('Authorization', o.amina.auth).send({ autoEnabled: false });
    o.t.clock.todayValue = '2026-09-17';
    expect(await o.t.container.services.reminders.runAutomatic()).toEqual({ sent: 0, failed: 0, skipped: 0 });
    o.t.clock.todayValue = '2026-09-10';
    await request(o.t.app).put('/api/v1/reminders/settings').set('Authorization', o.amina.auth).send({ autoEnabled: true });
  });
});

describe('scheduler', () => {
  it('runs once per day after the send time in London', async () => {
    let runs = 0;
    const s = new ReminderScheduler(new PgReminderRepository(o.t.db), async () => runs++, silentLogger);
    expect(localTime('Europe/London', new Date('2026-09-10T07:59:00Z'))).toBe('08:59'); // BST
    expect(await s.tick(new Date('2026-09-10T07:59:00Z'))).toBe(false); // 08:59 < 09:00
    expect(await s.tick(new Date('2026-09-10T08:00:00Z'))).toBe(true); // 09:00
    expect(await s.tick(new Date('2026-09-10T12:00:00Z'))).toBe(false); // already ran today
    expect(await s.tick(new Date('2026-09-11T08:30:00Z'))).toBe(true); // next day
    expect(runs).toBe(2);
  });
});

describe('reports', () => {
  async function workbook(res: request.Response) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    return wb;
  }
  const binary = (r: request.Test) =>
    r.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  it('exports the full learning log with summary + detail sheets', async () => {
    const res = await binary(request(o.t.app).get('/api/v1/reports/team/log').set('Authorization', o.amina.auth));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('project-accountants-log-report-2026.xlsx');
    const wb = await workbook(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Learning Log']);
    expect(wb.getWorksheet('Learning Log')!.rowCount).toBe(1 + 8 * 2); // header + 8 people × 2 items
  });

  it("scopes a manager's export to their own team", async () => {
    const res = await binary(request(o.t.app).get('/api/v1/reports/team/completion').set('Authorization', o.priya.auth));
    const wb = await workbook(res);
    const detail = wb.getWorksheet('Detail')!;
    const members = new Set<string>();
    detail.eachRow((row, n) => n > 1 && members.add(String(row.getCell(1).value)));
    expect([...members]).toEqual(['Grace Lin']);
  });

  it('exports ICAEW log of completed activity only, honouring the period', async () => {
    const inRange = await binary(request(o.t.app).get('/api/v1/reports/team/icaew?from=2026-09-01&to=2026-09-30').set('Authorization', o.amina.auth));
    expect((await workbook(inRange)).getWorksheet('ICAEW CPD Log')!.rowCount).toBe(2);
    const outRange = await binary(request(o.t.app).get('/api/v1/reports/team/icaew?from=2026-01-01&to=2026-06-30').set('Authorization', o.amina.auth));
    expect((await workbook(outRange)).getWorksheet('ICAEW CPD Log')!.rowCount).toBe(1);
  });

  it('validates report kind and period, and blocks team reports for team members', async () => {
    expect((await request(o.t.app).get('/api/v1/reports/team/everything').set('Authorization', o.amina.auth)).status).toBe(400);
    expect((await request(o.t.app).get('/api/v1/reports/team/log?from=2026-09-30&to=2026-01-01').set('Authorization', o.amina.auth)).status).toBe(400);
    expect((await request(o.t.app).get('/api/v1/reports/team/log').set('Authorization', o.sarah.auth)).status).toBe(403);
  });

  it('gives anyone their own CPD record', async () => {
    const res = await binary(request(o.t.app).get('/api/v1/reports/me/all').set('Authorization', o.sarah.auth));
    expect(res.headers['content-disposition']).toContain('sarah-whitfield-cpd-all-2026.xlsx');
    const wb = await workbook(res);
    const cover = wb.getWorksheet('CPD Record')!;
    expect(cover.getCell('B3').value).toBe('Sarah Whitfield');
    expect(wb.getWorksheet('Activity')!.rowCount).toBe(3);
  });
});
