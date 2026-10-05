/**
 * Read-only setup check: validates .env and probes Supabase (database, auth admin,
 * storage bucket, JWKS). Prints pass/fail only - never secret values.
 *
 *   npm run check:setup
 */
import { loadEnv } from '../src/infrastructure/config/env.js';
import { PgDatabase } from '../src/infrastructure/database/pg-database.js';

const ok = (label: string, detail = '') => console.log(`  ✔ ${label}${detail ? ` - ${detail}` : ''}`);
const fail = (label: string, detail: string) => {
  console.log(`  ✘ ${label} - ${detail}`);
  process.exitCode = 1;
};

async function main() {
  console.log('Configuration');
  let env;
  try {
    env = loadEnv();
    ok('.env is valid');
  } catch (err) {
    fail('.env', (err as Error).message);
    return;
  }
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  console.log('Database');
  const db = new PgDatabase({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL, max: 1 });
  try {
    await db.ping();
    ok('connected');
    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    );
    const names = tables.rows.map((r) => r.table_name);
    const expected = [
      'audit_events',
      'categories',
      'completions',
      'cpd_types',
      'delivery_types',
      'designations',
      'evidence_checks',
      'learning_cycles',
      'learning_item_designations',
      'learning_item_profiles',
      'learning_items',
      'notification_log',
      'profiles',
      'reminder_log',
      'reminder_settings',
    ];
    const missing = expected.filter((t) => !names.includes(t));
    if (missing.length === 0) ok(`all ${expected.length} tables present`);
    else fail('tables', `missing ${missing.length}: ${missing.join(', ')} - run the migrations`);
    if (missing.length === 0) {
      const counts = await db.query<{ d: number; c: number; cur: number; p: number }>(
        `select (select count(*)::int from designations) d, (select count(*)::int from categories) c,
                (select count(*)::int from learning_cycles where is_current) cur, (select count(*)::int from profiles) p`,
      );
      const r = counts.rows[0]!;
      if (r.d === 7 && r.c === 7 && r.cur === 1) ok('reference data present', `${r.p} profile(s) so far`);
      else fail('reference data', 'run migration 20261004000200_reference_data.sql');
      const rls = await db.query<{ n: number }>(
        `select count(*)::int n from pg_class c join pg_namespace s on s.oid = c.relnamespace
         where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
      );
      if (rls.rows[0]!.n === 0) ok('row-level security on every table');
      else fail('row-level security', `${rls.rows[0]!.n} table(s) without RLS`);
    }
  } catch (err) {
    fail(
      'database',
      `${(err as Error).message} - check DATABASE_URL (Session pooler string, password filled in) and DATABASE_SSL`,
    );
  } finally {
    await db.close().catch(() => undefined);
  }

  console.log('Supabase services');
  try {
    const res = await fetch(`${base}/auth/v1/admin/users?per_page=1`, { headers });
    if (res.ok) ok('auth admin API (service-role key accepted)');
    else
      fail(
        'auth admin API',
        `HTTP ${res.status} - check SUPABASE_SERVICE_ROLE_KEY is the service_role / secret key`,
      );
  } catch (err) {
    fail('auth admin API', (err as Error).message);
  }
  try {
    const res = await fetch(`${base}/storage/v1/bucket/${env.EVIDENCE_BUCKET}`, { headers });
    if (res.ok) {
      const bucket = (await res.json()) as { public?: boolean };
      if (bucket.public) fail('storage bucket', `"${env.EVIDENCE_BUCKET}" is PUBLIC - make it private`);
      else ok(`storage bucket "${env.EVIDENCE_BUCKET}" exists and is private`);
    } else
      fail('storage bucket', `HTTP ${res.status} - run migration 20261004000300_storage_evidence_bucket.sql`);
  } catch (err) {
    fail('storage bucket', (err as Error).message);
  }
  try {
    const res = await fetch(`${base}/auth/v1/.well-known/jwks.json`);
    const body = (await res.json()) as { keys?: unknown[] };
    if (res.ok && body.keys?.length) ok('JWT signing keys (JWKS) available');
    else if (env.SUPABASE_JWT_SECRET) ok('using legacy JWT secret (SUPABASE_JWT_SECRET)');
    else
      fail('JWT verification', 'no JWKS keys published - set SUPABASE_JWT_SECRET (legacy projects) in .env');
  } catch (err) {
    fail('JWKS', (err as Error).message);
  }
  try {
    const res = await fetch(`${base}/auth/v1/settings`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY },
    });
    const s = (await res.json()) as { disable_signup?: boolean };
    if (s.disable_signup) ok('public sign-up disabled');
    else
      console.log(
        '  ! public sign-up is ON - recommended: Authentication → Sign In / Providers → turn off "Allow new users to sign up"',
      );
  } catch {
    /* informational only */
  }

  console.log('\nAI evidence verification');
  if (!env.GEMINI_API_KEY) {
    console.log('  - off (no GEMINI_API_KEY) - evidence waits for the Learning Team to review');
  } else {
    // Lists models with the key (free; no file is sent). The key goes in a header, never the URL.
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) fail('Gemini API key', `HTTP ${res.status} - check GEMINI_API_KEY`);
      else {
        const body = (await res.json()) as { models?: { name: string }[] };
        const names = (body.models ?? []).map((m) => m.name.replace(/^models\//, ''));
        const flash = names.filter((n) => n.includes('flash')).join(', ') || 'none';
        for (const [label, model] of [
          ['model', env.GEMINI_MODEL],
          ...env.GEMINI_FALLBACK_MODELS.map((m) => ['fallback model', m] as const),
        ] as const) {
          if (names.includes(model)) ok(`Gemini ${label} "${model}" available`);
          else fail(`Gemini ${label}`, `"${model}" not found. Flash models on this key: ${flash}`);
        }
      }
    } catch (err) {
      fail('Gemini API', (err as Error).message);
    }
    if (!env.AI_VERIFICATION_ENABLED) console.log('  ! key set but AI_VERIFICATION_ENABLED=false - checks will not run');
  }
}

void main();
