import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExcelWorkbook } from '../../src/infrastructure/external-services/excel-workbook.js';
import { createOrg, type Org } from '../support/org.js';
import { lookupIds } from '../support/test-app.js';

let o: Org;
let ids: Awaited<ReturnType<typeof lookupIds>>;

const body = (over: Record<string, unknown> = {}) => ({
  title: 'Anti-Money Laundering Refresh',
  categoryId: ids.categories['Mandatory Compliance'],
  cpdTypeId: ids.cpdTypes['Mandatory Compliance'],
  deliveryTypeId: ids.deliveryTypes['eLearning'],
  provider: 'ICAEW',
  hours: 1.5,
  dueDate: '2026-03-31',
  isMandatory: true,
  evidenceMode: 'certificate',
  link: 'https://www.icaew.com',
  description: 'Annual AML refresher.',
  audience: { all: true },
  ...over,
});

beforeAll(async () => {
  o = await createOrg();
  ids = await lookupIds(o.t.db);
});

afterAll(async () => {
  await o.t.close();
});

describe('learning items', () => {
  let itemId: string;

  it('lets the Learning Team create an item (201) with names resolved', async () => {
    const res = await request(o.t.app).post('/api/v1/items').set('Authorization', o.amina.auth).send(body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'Anti-Money Laundering Refresh',
      category: { name: 'Mandatory Compliance' },
      deliveryType: { name: 'eLearning' },
      hours: 1.5,
      dueDate: '2026-03-31',
      audience: { all: true, label: 'All staff' },
      archived: false,
    });
    itemId = res.body.data.id;
  });

  it('forbids everyone else from changing the template', async () => {
    for (const who of [o.elena, o.daniel, o.sarah]) {
      const res = await request(o.t.app).post('/api/v1/items').set('Authorization', who.auth).send(body());
      expect(res.status).toBe(403);
    }
  });

  it('assigns by designation and named person, with a readable label', async () => {
    const res = await request(o.t.app)
      .post('/api/v1/items')
      .set('Authorization', o.amina.auth)
      .send(body({ title: 'IFRS 16', isMandatory: false, audience: { all: false, designationIds: [ids.designations['Senior Accountant']], profileIds: [o.grace.id] } }));
    expect(res.status).toBe(201);
    expect(res.body.data.audience).toMatchObject({ all: false, label: 'Senior Accountant, Grace Lin' });
  });

  it('validates input: empty audience, bad link, unknown lookup, negative hours', async () => {
    const cases = [
      body({ audience: { all: false } }),
      body({ link: 'javascript:alert(1)' }),
      body({ categoryId: 999 }),
      body({ hours: -1 }),
    ];
    for (const c of cases) {
      const res = await request(o.t.app).post('/api/v1/items').set('Authorization', o.amina.auth).send(c);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
  });

  it('updates an item', async () => {
    const res = await request(o.t.app).put(`/api/v1/items/${itemId}`).set('Authorization', o.amina.auth).send(body({ hours: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.data.hours).toBe(2);
  });

  it('lists the template for admins, HR and managers, not team members', async () => {
    expect((await request(o.t.app).get('/api/v1/items').set('Authorization', o.amina.auth)).body.data).toHaveLength(2);
    expect((await request(o.t.app).get('/api/v1/items').set('Authorization', o.elena.auth)).status).toBe(200);
    expect((await request(o.t.app).get('/api/v1/items').set('Authorization', o.priya.auth)).status).toBe(200);
    expect((await request(o.t.app).get('/api/v1/items').set('Authorization', o.sarah.auth)).status).toBe(403);
  });

  it('archives instead of deleting, and hides archived items by default', async () => {
    const del = await request(o.t.app).delete(`/api/v1/items/${itemId}`).set('Authorization', o.amina.auth);
    expect(del.status).toBe(204);
    const list = await request(o.t.app).get('/api/v1/items').set('Authorization', o.amina.auth);
    expect(list.body.data.map((i: { id: string }) => i.id)).not.toContain(itemId);
    const all = await request(o.t.app).get('/api/v1/items?includeArchived=true').set('Authorization', o.amina.auth);
    expect(all.body.data.find((i: { id: string }) => i.id === itemId).archived).toBe(true);
    const row = await o.t.db.query('select 1 from learning_items where id = $1', [itemId]);
    expect(row.rows).toHaveLength(1);
  });

  it('refuses to edit an archived item', async () => {
    const res = await request(o.t.app).put(`/api/v1/items/${itemId}`).set('Authorization', o.amina.auth).send(body());
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ITEM_ARCHIVED');
  });

  it('copies the template into a new year with due dates shifted', async () => {
    const cycles = await request(o.t.app).get('/api/v1/cycles').set('Authorization', o.amina.auth);
    const from = cycles.body.data[0].id;
    const res = await request(o.t.app)
      .post('/api/v1/cycles')
      .set('Authorization', o.amina.auth)
      .send({ year: 2027, startsOn: '2027-01-01', endsOn: '2027-12-31', copyItemsFromCycleId: from });
    expect(res.status).toBe(201);
    expect(res.body.data.copiedItems).toBe(1); // the archived item is not copied
    const items = await request(o.t.app).get(`/api/v1/items?cycleId=${res.body.data.id}`).set('Authorization', o.amina.auth);
    expect(items.body.data[0]).toMatchObject({ title: 'IFRS 16', dueDate: '2027-03-31' });
  });
});

describe('item import', () => {
  const workbook = new ExcelWorkbook();
  const sheet = (rows: (string | number)[][]) =>
    workbook.write([{ name: 'Learning Items', rows: [['name', 'category', 'cpd_type', 'type', 'provider', 'hours', 'due_date', 'mandatory', 'evidence', 'link', 'description', 'assign_to'], ...rows] }]);

  it('downloads a formatted template workbook', async () => {
    const res = await request(o.t.app).get('/api/v1/items/import/template').set('Authorization', o.amina.auth).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('learning-items-import-template.xlsx');
  });

  it('previews rows with per-row errors (reads category and cpd_type separately)', async () => {
    const file = await sheet([
      ['GDPR', 'Mandatory Compliance', 'Structured CPD', 'eLearning', 'Internal', 1, '30/04/2026', 'yes', '', '', '', 'all'],
      ['Excel', 'Technical Skills', '', 'Workshop', 'Internal', 4, '2026-07-31', 'no', 'acknowledgement', '', '', 'Junior Accountant; imoolla@pa.co.uk'],
      ['', 'Nope', '', '', '', 'abc', 'not-a-date', 'maybe', '', 'ftp://x', '', 'Astronaut'],
    ]);
    const res = await request(o.t.app)
      .post('/api/v1/items/import/preview')
      .set('Authorization', o.amina.auth)
      .attach('file', file, 'items.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ validCount: 2, errorCount: 1 });
    const [gdpr, excel, bad] = res.body.data.rows;
    expect(gdpr.summary).toMatchObject({ title: 'GDPR', dueDate: '2026-04-30', assignTo: 'all' });
    expect(excel.errors).toEqual([]);
    expect(bad.errors.join(' | ')).toMatch(/name is required.*hours.*category.*due_date.*mandatory.*link.*Astronaut/);
  });

  it('rejects the whole batch if any row is invalid, then imports a clean batch', async () => {
    const good = { rowNumber: 2, values: { name: 'GDPR', category: 'Mandatory Compliance', cpd_type: 'Structured CPD', hours: '1', assign_to: 'all' } };
    const bad = { rowNumber: 3, values: { name: '', hours: '0' } };
    const rejected = await request(o.t.app).post('/api/v1/items/import').set('Authorization', o.amina.auth).send({ rows: [good, bad] });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('IMPORT_INVALID');

    const ok = await request(o.t.app).post('/api/v1/items/import').set('Authorization', o.amina.auth).send({ rows: [good] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.created).toBe(1);
    const row = await o.t.db.query<{ cpd: string }>(
      `select t.name as cpd from learning_items i join cpd_types t on t.id = i.cpd_type_id where i.title = 'GDPR'`,
    );
    expect(row.rows[0]!.cpd).toBe('Structured CPD');
  });

  it('accepts CSV and rejects other file types', async () => {
    const csv = Buffer.from('name,hours,assign_to\nEthics,2.5,all\n');
    const ok = await request(o.t.app).post('/api/v1/items/import/preview').set('Authorization', o.amina.auth).attach('file', csv, 'items.csv');
    expect(ok.body.data.validCount).toBe(1);
    const bad = await request(o.t.app).post('/api/v1/items/import/preview').set('Authorization', o.amina.auth).attach('file', csv, 'items.xls');
    expect(bad.status).toBe(415);
  });
});
