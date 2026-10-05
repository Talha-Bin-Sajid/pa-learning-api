import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg, type Org } from '../support/org.js';
import { lookupIds } from '../support/test-app.js';

let o: Org;
let ids: Awaited<ReturnType<typeof lookupIds>>;

beforeAll(async () => {
  o = await createOrg();
  ids = await lookupIds(o.t.db);
});

afterAll(async () => {
  await o.t.close();
});

describe('user management', () => {
  it('lists people with designation, manager and report counts (admin only)', async () => {
    const res = await request(o.t.app).get('/api/v1/users').set('Authorization', o.amina.auth);
    expect(res.status).toBe(200);
    const daniel = res.body.data.find((p: { email: string }) => p.email === 'dokoro@pa.co.uk');
    expect(daniel).toMatchObject({ role: 'manager', designation: { name: 'Director' }, reportCount: 2 });
    const sarah = res.body.data.find((p: { email: string }) => p.email === 'swhitfield@pa.co.uk');
    expect(sarah.lineManager).toMatchObject({ fullName: 'Daniel Okoro' });

    expect((await request(o.t.app).get('/api/v1/users').set('Authorization', o.elena.auth)).status).toBe(403);
    expect((await request(o.t.app).get('/api/v1/users?search=sarah').set('Authorization', o.amina.auth)).body.data).toHaveLength(1);
  });

  it('adds a person with the default reporting access for their designation', async () => {
    const res = await request(o.t.app)
      .post('/api/v1/users')
      .set('Authorization', o.amina.auth)
      .send({ fullName: 'Paula Partner', email: 'PPartner@pa.co.uk', role: 'team_member', designationId: ids.designations['Partner'], lineManagerId: null });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: 'ppartner@pa.co.uk', reportingAccess: 'full', hasAccount: false });
  });

  it('rejects a duplicate email', async () => {
    const res = await request(o.t.app)
      .post('/api/v1/users')
      .set('Authorization', o.amina.auth)
      .send({ fullName: 'Dup', email: 'GLIN@pa.co.uk', role: 'team_member', designationId: null, lineManagerId: null });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
  });

  it('recomputes access when role changes, unless access is set explicitly', async () => {
    const promoted = await request(o.t.app).patch(`/api/v1/users/${o.tomas.id}`).set('Authorization', o.amina.auth).send({ role: 'hr' });
    expect(promoted.body.data).toMatchObject({ role: 'hr', reportingAccess: 'full' });
    const explicit = await request(o.t.app)
      .patch(`/api/v1/users/${o.tomas.id}`)
      .set('Authorization', o.amina.auth)
      .send({ role: 'team_member', reportingAccess: 'full' });
    expect(explicit.body.data).toMatchObject({ role: 'team_member', reportingAccess: 'full' });
  });

  it('prevents reporting loops and self-management', async () => {
    const loop = await request(o.t.app).patch(`/api/v1/users/${o.daniel.id}`).set('Authorization', o.amina.auth).send({ lineManagerId: o.sarah.id });
    expect(loop.status).toBe(422);
    expect(loop.body.code).toBe('REPORTING_LOOP');
    const self = await request(o.t.app).patch(`/api/v1/users/${o.sarah.id}`).set('Authorization', o.amina.auth).send({ lineManagerId: o.sarah.id });
    expect(self.body.code).toBe('INVALID_LINE_MANAGER');
  });

  it('stops admins from demoting or deactivating themselves', async () => {
    const demote = await request(o.t.app).patch(`/api/v1/users/${o.amina.id}`).set('Authorization', o.amina.auth).send({ role: 'manager' });
    expect(demote.body.code).toBe('SELF_DEMOTION');
    const deactivate = await request(o.t.app).patch(`/api/v1/users/${o.amina.id}`).set('Authorization', o.amina.auth).send({ status: 'inactive' });
    expect(deactivate.body.code).toBe('SELF_DEACTIVATION');
  });

  it('saves inline edits atomically: one bad change rolls back all', async () => {
    const res = await request(o.t.app)
      .patch('/api/v1/users')
      .set('Authorization', o.amina.auth)
      .send({ updates: [{ id: o.grace.id, designationId: ids.designations['Accountant'] }, { id: o.daniel.id, lineManagerId: o.tomas.id }] });
    expect(res.status).toBe(422);
    const grace = await o.t.db.query<{ name: string }>('select d.name from profiles p join designations d on d.id = p.designation_id where p.id = $1', [o.grace.id]);
    expect(grace.rows[0]!.name).toBe('Junior Accountant');

    const okRes = await request(o.t.app)
      .patch('/api/v1/users')
      .set('Authorization', o.amina.auth)
      .send({ updates: [{ id: o.grace.id, designationId: ids.designations['Accountant'] }] });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data[0].designation.name).toBe('Accountant');
  });
});

describe('user import', () => {
  it('previews create vs update, resolves managers inside the file, flags problems', async () => {
    const csv = Buffer.from(
      [
        'name,email,role,designation,access,line_manager_email',
        'New Boss,boss@pa.co.uk,Manager,Senior Manager,,',
        'New Starter,starter@pa.co.uk,Team Member,Junior Accountant,,boss@pa.co.uk',
        'Grace Lin,glin@pa.co.uk,Team Member,Accountant,,',
        'Broken,not-an-email,Wizard,Astronaut,maybe,ghost@pa.co.uk',
      ].join('\n'),
    );
    const res = await request(o.t.app).post('/api/v1/users/import/preview').set('Authorization', o.amina.auth).attach('file', csv, 'users.csv');
    expect(res.status).toBe(200);
    const [boss, starter, grace, broken] = res.body.data.rows;
    expect(boss.action).toBe('create');
    expect(starter.action).toBe('create');
    expect(grace.action).toBe('update');
    expect(broken.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('detects loops created inside the file', async () => {
    const rows = [
      { rowNumber: 2, values: { name: 'A', email: 'a@pa.co.uk', line_manager_email: 'b@pa.co.uk' } },
      { rowNumber: 3, values: { name: 'B', email: 'b@pa.co.uk', line_manager_email: 'a@pa.co.uk' } },
    ];
    const res = await request(o.t.app).post('/api/v1/users/import').set('Authorization', o.amina.auth).send({ rows });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details)).toContain('reporting loop');
  });

  it('imports: creates, updates by email and links managers', async () => {
    const rows = [
      { rowNumber: 2, values: { name: 'New Boss', email: 'boss@pa.co.uk', role: 'Manager', designation: 'Senior Manager' } },
      { rowNumber: 3, values: { name: 'New Starter', email: 'starter@pa.co.uk', role: '', designation: 'Junior Accountant', line_manager_email: 'boss@pa.co.uk' } },
      { rowNumber: 4, values: { name: 'Grace Lin', email: 'glin@pa.co.uk', role: 'Team Member', designation: 'Senior Accountant' } },
    ];
    const res = await request(o.t.app).post('/api/v1/users/import').set('Authorization', o.amina.auth).send({ rows });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ added: 2, updated: 1 });

    const list = await request(o.t.app).get('/api/v1/users?search=starter').set('Authorization', o.amina.auth);
    expect(list.body.data[0]).toMatchObject({ role: 'team_member', lineManager: { fullName: 'New Boss' }, reportingAccess: 'self' });
  });
});
