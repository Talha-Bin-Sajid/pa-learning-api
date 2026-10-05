/**
 * DEV utility — moves accounts from one email domain to another, in Supabase Auth
 * AND in profiles, keeping ids, passwords, roles and history.
 *
 *   npm run rename:domain -- pa-demo.test projectaccountants.co.uk
 *
 * Skips anyone whose new address is already taken. Refuses to run in production.
 */
import { loadEnv } from '../src/infrastructure/config/env.js';
import { PgDatabase } from '../src/infrastructure/database/pg-database.js';

const env = loadEnv();
if (env.NODE_ENV === 'production') throw new Error('rename:domain must not run in production.');
const [from, to] = process.argv.slice(2).map((d) => d?.trim().toLowerCase().replace(/^@/, ''));
if (!from || !to || from === to) throw new Error('Usage: npm run rename:domain -- <from-domain> <to-domain>');

const db = new PgDatabase({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL, max: 2 });
const base = env.SUPABASE_URL.replace(/\/$/, '');
const headers = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

async function main() {
  const people = await db.query<{ id: string; email: string; auth_user_id: string | null; full_name: string }>(
    `select id, email, auth_user_id, full_name from profiles where lower(email) like $1 order by full_name`,
    [`%@${from}`],
  );
  if (people.rows.length === 0) {
    console.log(`No profiles with @${from} — nothing to do.`);
    return;
  }
  let moved = 0;
  for (const p of people.rows) {
    const next = `${p.email.slice(0, p.email.lastIndexOf('@'))}@${to}`;
    const taken = await db.query('select 1 from profiles where lower(email) = lower($1)', [next]);
    if (taken.rows.length) {
      console.log(`= ${p.full_name}: ${next} already exists — skipped`);
      continue;
    }
    if (p.auth_user_id) {
      const res = await fetch(`${base}/auth/v1/admin/users/${p.auth_user_id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ email: next, email_confirm: true }),
      });
      if (!res.ok) {
        console.log(`✘ ${p.full_name}: auth update failed (HTTP ${res.status}) — skipped`);
        continue;
      }
    }
    await db.query('update profiles set email = $2 where id = $1', [p.id, next]);
    console.log(`✔ ${p.full_name}: ${p.email} → ${next}`);
    moved++;
  }
  console.log(`\nDone: ${moved} of ${people.rows.length} moved to @${to}. Passwords are unchanged.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
