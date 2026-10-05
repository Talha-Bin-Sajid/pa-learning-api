import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase } from '../support/test-database.js';

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDatabase();
});

afterAll(async () => {
  await db.close();
});

// Each test runs in a transaction that is rolled back, keeping tests independent.
beforeEach(async () => {
  await db.exec('begin');
});

afterEach(async () => {
  await db.exec('rollback');
});

async function insertProfile(email: string): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into profiles (full_name, email) values ('Test Person', $1) returning id`,
    [email],
  );
  return res.rows[0]!.id;
}

async function currentCycleId(): Promise<string> {
  const res = await db.query<{ id: string }>('select id from learning_cycles where is_current');
  return res.rows[0]!.id;
}

async function insertItem(cycleId: string, opts: { hours?: number; link?: string } = {}): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into learning_items (cycle_id, title, category_id, cpd_type_id, delivery_type_id, hours, link)
     values ($1, 'AML Refresh', 1, 1, 1, $2, $3) returning id`,
    [cycleId, opts.hours ?? 1.5, opts.link ?? null],
  );
  return res.rows[0]!.id;
}

/** Asserts the statement fails, then restores the transaction so the test can continue. */
async function expectViolation(sql: string, params: unknown[] = []): Promise<void> {
  await db.exec('savepoint sp');
  await expect(db.query(sql, params)).rejects.toThrow();
  await db.exec('rollback to savepoint sp');
}

async function insertCompletion(person: string, item: string, evidence?: { path: string; size: number }) {
  if (!evidence) {
    return db.query(`insert into completions (profile_id, item_id, completed_on) values ($1, $2, '2026-02-01')`, [
      person,
      item,
    ]);
  }
  return db.query(
    `insert into completions (profile_id, item_id, completed_on, evidence_path, evidence_file_name, evidence_mime_type, evidence_size_bytes)
     values ($1, $2, '2026-02-01', $3, 'cert.pdf', 'application/pdf', $4)`,
    [person, item, evidence.path, evidence.size],
  );
}

describe('reference data', () => {
  it('seeds the prototype lookup lists', async () => {
    const counts = await db.query<{ t: string; n: number }>(`
      select 'designations' t, count(*)::int n from designations union all
      select 'categories', count(*)::int from categories union all
      select 'cpd_types', count(*)::int from cpd_types union all
      select 'delivery_types', count(*)::int from delivery_types`);
    expect(Object.fromEntries(counts.rows.map((r) => [r.t, r.n]))).toEqual({
      designations: 7,
      categories: 7,
      cpd_types: 4,
      delivery_types: 8,
    });
  });

  it('marks only Director and Partner as granting full access', async () => {
    const res = await db.query<{ name: string }>('select name from designations where grants_full_access order by rank');
    expect(res.rows.map((r) => r.name)).toEqual(['Director', 'Partner']);
  });

  it('creates a single current 2026 cycle and default reminder settings', async () => {
    const cycles = await db.query<{ year: number }>('select year from learning_cycles where is_current');
    expect(cycles.rows).toEqual([{ year: 2026 }]);
    const settings = await db.query<{ lead_days: number[]; overdue_frequency: string }>(
      'select lead_days, overdue_frequency from reminder_settings',
    );
    expect(settings.rows).toEqual([{ lead_days: [30, 14, 7], overdue_frequency: 'weekly' }]);
  });
});

describe('profiles', () => {
  it('treats email as case-insensitively unique', async () => {
    await insertProfile('a.person@projectaccountants.co.uk');
    await expectViolation(`insert into profiles (full_name, email) values ('X', 'A.Person@ProjectAccountants.co.uk')`);
  });

  it('rejects a person being their own line manager', async () => {
    const id = await insertProfile('self@projectaccountants.co.uk');
    await expectViolation('update profiles set line_manager_id = id where id = $1', [id]);
  });

  it('rejects malformed emails and blank names', async () => {
    await expectViolation(`insert into profiles (full_name, email) values ('X', 'not-an-email')`);
    await expectViolation(`insert into profiles (full_name, email) values ('   ', 'ok@example.com')`);
  });

  it('maintains updated_at on update', async () => {
    const id = await insertProfile('ts@projectaccountants.co.uk');
    await db.query(`update profiles set updated_at = now() - interval '1 day' where id = $1`, [id]);
    await db.query(`update profiles set full_name = 'Renamed' where id = $1`, [id]);
    const res = await db.query<{ fresh: boolean }>(
      `select updated_at > now() - interval '1 minute' as fresh from profiles where id = $1`,
      [id],
    );
    expect(res.rows[0]!.fresh).toBe(true);
  });
});

describe('learning cycles', () => {
  it('allows only one current cycle', async () => {
    await expectViolation(
      `insert into learning_cycles (year, name, starts_on, ends_on, is_current) values (2027, '2027', '2027-01-01', '2027-12-31', true)`,
    );
  });

  it('requires ends_on after starts_on', async () => {
    await expectViolation(
      `insert into learning_cycles (year, name, starts_on, ends_on) values (2028, '2028', '2028-12-31', '2028-01-01')`,
    );
  });
});

describe('learning items', () => {
  it('requires positive hours within the limit', async () => {
    const cycle = await currentCycleId();
    await db.exec('savepoint sp');
    await expect(insertItem(cycle, { hours: 0 })).rejects.toThrow();
    await db.exec('rollback to savepoint sp');
    await expect(insertItem(cycle, { hours: 501 })).rejects.toThrow();
  });

  it('only accepts http(s) links', async () => {
    const cycle = await currentCycleId();
    await expect(insertItem(cycle, { link: 'javascript:alert(1)' })).rejects.toThrow();
  });

  it('cannot hard-delete a cycle that has items', async () => {
    const cycle = await currentCycleId();
    await insertItem(cycle);
    await expectViolation('delete from learning_cycles where id = $1', [cycle]);
  });
});

describe('completions', () => {
  it('allows one completion per person per item', async () => {
    const person = await insertProfile('c1@projectaccountants.co.uk');
    const item = await insertItem(await currentCycleId());
    await insertCompletion(person, item);
    await db.exec('savepoint sp');
    await expect(insertCompletion(person, item)).rejects.toThrow();
    await db.exec('rollback to savepoint sp');
  });

  it('requires evidence columns to be all set or all empty', async () => {
    const person = await insertProfile('c2@projectaccountants.co.uk');
    const item = await insertItem(await currentCycleId());
    await expectViolation(
      `insert into completions (profile_id, item_id, completed_on, evidence_path) values ($1, $2, '2026-02-01', 'x/y.pdf')`,
      [person, item],
    );
    await insertCompletion(person, item, { path: 'x/y.pdf', size: 1024 });
  });

  it('rejects evidence over 15 MB', async () => {
    const person = await insertProfile('c3@projectaccountants.co.uk');
    const item = await insertItem(await currentCycleId());
    await expect(insertCompletion(person, item, { path: 'x/y.pdf', size: 15 * 1024 * 1024 + 1 })).rejects.toThrow();
  });

  it('prevents hard-deleting an item that has completions', async () => {
    const person = await insertProfile('c4@projectaccountants.co.uk');
    const item = await insertItem(await currentCycleId());
    await insertCompletion(person, item);
    await expectViolation('delete from learning_items where id = $1', [item]);
  });
});

describe('reminders', () => {
  it('allows one automatic reminder per person per day, but any number of manual ones', async () => {
    const person = await insertProfile('r1@projectaccountants.co.uk');
    const insert = `insert into reminder_log (recipient_id, kind, run_date, delivery_status) values ($1, $2, '2026-09-01', 'sent')`;
    await db.query(insert, [person, 'automatic']);
    await expectViolation(insert, [person, 'automatic']);
    await db.query(insert, [person, 'manual']);
    await db.query(insert, [person, 'manual']);
  });

  it('validates lead days and keeps a single settings row', async () => {
    await expectViolation(`update reminder_settings set lead_days = '{0}'`);
    await expectViolation(`update reminder_settings set lead_days = '{400}'`);
    await expectViolation(`insert into reminder_settings (id) values (2)`);
  });
});

describe('security', () => {
  it('enables row level security on every public table', async () => {
    const res = await db.query<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(res.rows).toEqual([]);
  });
});
