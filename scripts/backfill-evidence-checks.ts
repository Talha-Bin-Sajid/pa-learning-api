/**
 * One-off: brings evidence uploaded *before* automatic checks were switched on
 * into the new flow.
 *
 *   npm run evidence:backfill            → dry run (shows what it would do)
 *   npm run evidence:backfill -- --apply → does it
 *
 * 1. Fills in the file fingerprint (SHA-256) where missing, so duplicate files are spotted.
 * 2. Queues an automatic check for every file still "not reviewed" with no check yet.
 *    Decisions already made (verified / flagged / rejected) are left alone.
 * The running API's worker then processes the queue (AI_VERIFICATION_ENABLED=true).
 */
import { createHash } from 'node:crypto';
import { loadEnv } from '../src/infrastructure/config/env.js';
import { PgDatabase } from '../src/infrastructure/database/pg-database.js';
import { SupabaseFileStorage } from '../src/infrastructure/external-services/supabase-file-storage.js';

const env = loadEnv();
const apply = process.argv.includes('--apply');
const db = new PgDatabase({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL, max: 1 });
const storage = new SupabaseFileStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.EVIDENCE_BUCKET);

async function main() {
  if (!env.AI_VERIFICATION_ENABLED) console.log('! AI_VERIFICATION_ENABLED is false - queued checks will wait until it is on.\n');

  const missing = await db.query<{ id: string; evidence_path: string }>(
    'select id, evidence_path from completions where evidence_path is not null and evidence_sha256 is null',
  );
  console.log(`${missing.rows.length} file(s) without a fingerprint`);
  let hashed = 0;
  for (const r of missing.rows) {
    if (!apply) continue;
    try {
      const bytes = await storage.download(r.evidence_path);
      const sha = createHash('sha256').update(bytes).digest('hex');
      await db.query('update completions set evidence_sha256 = $2 where id = $1', [r.id, sha]);
      hashed++;
    } catch (err) {
      console.log(`  - ${r.id}: could not read the file (${(err as Error).message})`);
    }
  }

  const pending = await db.query<{ id: string; evidence_path: string }>(
    `select c.id, c.evidence_path from completions c
     where c.evidence_path is not null and c.review_status = 'not_reviewed'
       and not exists (select 1 from evidence_checks k where k.completion_id = c.id and k.status <> 'superseded')`,
  );
  console.log(`${pending.rows.length} submission(s) never checked`);
  if (apply && pending.rows.length) {
    await db.query(
      `insert into evidence_checks (completion_id, evidence_path)
       select c.id, c.evidence_path from completions c
       where c.evidence_path is not null and c.review_status = 'not_reviewed'
         and not exists (select 1 from evidence_checks k where k.completion_id = c.id and k.status <> 'superseded')`,
    );
  }

  console.log(
    apply
      ? `\nDone: ${hashed} fingerprint(s) added, ${pending.rows.length} check(s) queued.`
      : '\nDry run - nothing changed. Run again with: npm run evidence:backfill -- --apply',
  );
}

main()
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => void db.close());
