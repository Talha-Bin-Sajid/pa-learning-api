/**
 * DEV utility — sets a new password for one account, or every account on a domain,
 * via the Supabase Auth admin API. No emails are sent; nobody is deleted.
 *
 *   $env:NEW_PASSWORD="..."; npm run set:password -- apatel@projectaccountants.co.uk
 *   $env:NEW_PASSWORD="..."; npm run set:password -- projectaccountants.co.uk       (whole domain)
 *
 * The password comes from the NEW_PASSWORD environment variable (never a command
 * argument, so it doesn't end up in shell history). Refuses to run in production.
 */
import { loadEnv } from '../src/infrastructure/config/env.js';
import { PgDatabase } from '../src/infrastructure/database/pg-database.js';

const env = loadEnv();
if (env.NODE_ENV === 'production') throw new Error('set:password must not run in production.');
const raw = process.argv[2]?.trim().toLowerCase();
// A bare domain (no @ at all) means "everyone on that domain" — avoids PowerShell's @ splatting.
const target = raw && !raw.includes('@') ? `@${raw}` : raw;
const password = process.env.NEW_PASSWORD ?? '';
if (!target) throw new Error('Usage: npm run set:password -- <email | @domain>   (password in NEW_PASSWORD)');
if (password.length < 10) throw new Error('Set NEW_PASSWORD to at least 10 characters.');

const db = new PgDatabase({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL, max: 1 });
const base = env.SUPABASE_URL.replace(/\/$/, '');

async function main() {
  const where = target!.startsWith('@') ? 'lower(email) like $1' : 'lower(email) = $1';
  const value = target!.startsWith('@') ? `%${target}` : target!;
  const people = await db.query<{ full_name: string; email: string; auth_user_id: string | null }>(
    `select full_name, email, auth_user_id from profiles where ${where} order by full_name`,
    [value],
  );
  if (people.rows.length === 0) return console.log(`No profiles match ${target}.`);

  let done = 0;
  for (const p of people.rows) {
    if (!p.auth_user_id) {
      console.log(`- ${p.email}: no sign-in account yet — skipped`);
      continue;
    }
    const res = await fetch(`${base}/auth/v1/admin/users/${p.auth_user_id}`, {
      method: 'PUT',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      console.log(`✔ ${p.email}`);
      done++;
    } else {
      const body = (await res.json().catch(() => ({}))) as { msg?: string; message?: string };
      console.log(`✘ ${p.email}: ${body.msg ?? body.message ?? `HTTP ${res.status}`}`);
    }
  }
  console.log(`\nPassword updated for ${done} account(s). Existing sessions stay signed in until they expire.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
