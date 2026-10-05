import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/test-app.js';

let t: TestApp;
let admin: { id: string; auth: string };
let member: { id: string; auth: string };

beforeAll(async () => {
  t = await createTestApp();
  admin = await t.signInAs({ email: 'apatel@pa.co.uk', fullName: 'Amina Patel', role: 'learning_team', reportingAccess: 'full', designation: 'Senior Manager' });
  member = await t.signInAs({ email: 'imoolla@pa.co.uk', fullName: 'Ibraaheem Moolla', designation: 'Senior Accountant', lineManagerId: admin.id });
});

afterAll(async () => {
  await t.close();
});

describe('platform', () => {
  it('reports health', async () => {
    const res = await request(t.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: 'ok' } });
  });

  it('returns the error envelope for unknown routes', async () => {
    const res = await request(t.app).get('/api/v1/nope').set('Authorization', member.auth);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND' });
  });

  it('sets security headers and a request id', async () => {
    const res = await request(t.app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('authentication', () => {
  it('rejects requests without a token', async () => {
    const res = await request(t.app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: 'Sign in to continue.', code: 'UNAUTHENTICATED' });
  });

  it('rejects forged tokens', async () => {
    const res = await request(t.app).get('/api/v1/me').set('Authorization', 'Bearer forged');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('blocks inactive accounts', async () => {
    const gone = await t.signInAs({ email: 'gone@pa.co.uk', status: 'inactive' });
    const res = await request(t.app).get('/api/v1/me').set('Authorization', gone.auth);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('GET /me', () => {
  it('returns profile, permissions and the current cycle', async () => {
    const res = await request(t.app).get('/api/v1/me').set('Authorization', member.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      profile: {
        fullName: 'Ibraaheem Moolla',
        initials: 'IM',
        role: 'team_member',
        designation: { name: 'Senior Accountant' },
        lineManager: { id: admin.id, fullName: 'Amina Patel' },
      },
      permissions: { scope: 'self', viewTeam: false, manageItems: false },
      currentCycle: { year: 2026, isCurrent: true },
    });
  });
});

describe('POST /auth/register', () => {
  it('creates an account (201) without authentication', async () => {
    const res = await request(t.app)
      .post('/api/v1/auth/register')
      .send({ fullName: 'Grace Lin', email: 'glin@pa.co.uk', password: 'correct-horse-1' });
    expect(res.status).toBe(201);
    expect(res.body.data.profile).toMatchObject({ email: 'glin@pa.co.uk', role: 'team_member' });
  });

  it('validates the body with field details', async () => {
    const res = await request(t.app).post('/api/v1/auth/register').send({ email: 'bad', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(['email', 'fullName', 'password']);
  });

  it('returns 409 for an existing account', async () => {
    const res = await request(t.app)
      .post('/api/v1/auth/register')
      .send({ fullName: 'Again', email: 'imoolla@pa.co.uk', password: 'correct-horse-1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
  });

  it('rejects malformed JSON cleanly', async () => {
    const res = await request(t.app).post('/api/v1/auth/register').set('Content-Type', 'application/json').send('{"x":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });
});

describe('GET /lookups', () => {
  it('returns the reference lists', async () => {
    const res = await request(t.app).get('/api/v1/lookups').set('Authorization', member.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.designations).toHaveLength(7);
    expect(res.body.data.categories.map((c: { name: string }) => c.name)).toContain('Mandatory Compliance');
    expect(res.body.data.deliveryTypes).toHaveLength(8);
  });
});

describe('cycles', () => {
  it('lists cycles for anyone signed in', async () => {
    const res = await request(t.app).get('/api/v1/cycles').set('Authorization', member.auth);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ year: 2026, isCurrent: true });
  });

  it('forbids team members from creating a cycle', async () => {
    const res = await request(t.app)
      .post('/api/v1/cycles')
      .set('Authorization', member.auth)
      .send({ year: 2027, startsOn: '2027-01-01', endsOn: '2027-12-31' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('lets the Learning Team create the next year and make it current', async () => {
    const res = await request(t.app)
      .post('/api/v1/cycles')
      .set('Authorization', admin.auth)
      .send({ year: 2027, startsOn: '2027-01-01', endsOn: '2027-12-31', makeCurrent: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ year: 2027, name: '2027 programme', isCurrent: true, copiedItems: 0 });

    const list = await request(t.app).get('/api/v1/cycles').set('Authorization', admin.auth);
    expect(list.body.data.filter((c: { isCurrent: boolean }) => c.isCurrent)).toHaveLength(1);

    const audit = await t.db.query<{ action: string }>(`select action from audit_events where entity_type = 'learning_cycle'`);
    expect(audit.rows.map((r) => r.action)).toContain('cycle.created');
  });

  it('rejects a duplicate year and an inverted date range', async () => {
    const dup = await request(t.app)
      .post('/api/v1/cycles')
      .set('Authorization', admin.auth)
      .send({ year: 2026, startsOn: '2026-01-01', endsOn: '2026-12-31' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CYCLE_EXISTS');

    const bad = await request(t.app)
      .post('/api/v1/cycles')
      .set('Authorization', admin.auth)
      .send({ year: 2030, startsOn: '2030-12-31', endsOn: '2030-01-01' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('INVALID_DATE_RANGE');
  });

  it('switches the current year back with PATCH', async () => {
    const list = await request(t.app).get('/api/v1/cycles').set('Authorization', admin.auth);
    const y2026 = list.body.data.find((c: { year: number }) => c.year === 2026);
    const res = await request(t.app).patch(`/api/v1/cycles/${y2026.id}`).set('Authorization', admin.auth).send({ makeCurrent: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ year: 2026, isCurrent: true });
  });

  it('validates path ids', async () => {
    const res = await request(t.app).patch('/api/v1/cycles/not-a-uuid').set('Authorization', admin.auth).send({ name: 'x' });
    expect(res.status).toBe(400);
  });
});
