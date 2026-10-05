/**
 * DEV ONLY - fills a development Supabase project with the prototype's demo data:
 * 8 people (with sign-in accounts), line managers, 8 learning items and some completions.
 *
 *   SEED_DEMO_PASSWORD=<a password you choose> npm run seed:dev
 *
 * Idempotent: people/items that already exist are skipped. Refuses to run in production.
 * Demo emails use SEED_EMAIL_DOMAIN (default pa-demo.test) so they never collide with real staff.
 */
import { loadEnv } from '../src/infrastructure/config/env.js';
import { PgDatabase } from '../src/infrastructure/database/pg-database.js';
import { SupabaseIdentityProvider } from '../src/infrastructure/external-services/supabase-identity-provider.js';
import { ConflictError } from '../src/shared/errors/app-errors.js';

const env = loadEnv();
if (env.NODE_ENV === 'production') throw new Error('seed:dev must not run in production.');
const password = process.env.SEED_DEMO_PASSWORD;
if (!password || password.length < 10)
  throw new Error('Set SEED_DEMO_PASSWORD (at least 10 characters) to seed demo accounts.');
const domain = process.env.SEED_EMAIL_DOMAIN || 'pa-demo.test';

const db = new PgDatabase({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL, max: 2 });
const identity = new SupabaseIdentityProvider(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const PEOPLE = [
  {
    key: 'apatel',
    name: 'Amina Patel',
    role: 'learning_team',
    designation: 'Senior Manager',
    access: 'full',
    color: '#8843f8',
    manager: null,
  },
  {
    key: 'dokoro',
    name: 'Daniel Okoro',
    role: 'manager',
    designation: 'Director',
    access: 'full',
    color: '#2c609c',
    manager: null,
  },
  {
    key: 'praman',
    name: 'Priya Raman',
    role: 'manager',
    designation: 'Manager',
    access: 'self',
    color: '#ec4f3c',
    manager: 'dokoro',
  },
  {
    key: 'emarsh',
    name: 'Elena Marsh',
    role: 'hr',
    designation: 'Manager',
    access: 'full',
    color: '#6663fb',
    manager: null,
  },
  {
    key: 'swhitfield',
    name: 'Sarah Whitfield',
    role: 'team_member',
    designation: 'Accountant',
    access: 'self',
    color: '#2d8dfe',
    manager: 'dokoro',
  },
  {
    key: 'imoolla',
    name: 'Ibraaheem Moolla',
    role: 'team_member',
    designation: 'Senior Accountant',
    access: 'self',
    color: '#3193b1',
    manager: 'dokoro',
  },
  {
    key: 'glin',
    name: 'Grace Lin',
    role: 'team_member',
    designation: 'Junior Accountant',
    access: 'self',
    color: '#6663fb',
    manager: 'praman',
  },
  {
    key: 'tneri',
    name: 'Tomas Neri',
    role: 'team_member',
    designation: 'Accountant',
    access: 'self',
    color: '#57bfdf',
    manager: 'praman',
  },
] as const;

const ITEMS = [
  {
    title: 'Anti-Money Laundering Refresh',
    category: 'Mandatory Compliance',
    cpd: 'Mandatory Compliance',
    type: 'eLearning',
    provider: 'ICAEW',
    hours: 1.5,
    due: '2026-03-31',
    mandatory: true,
    evidence: 'certificate',
    link: 'https://www.icaew.com',
    description: 'Annual AML refresher covering client due diligence, red flags and reporting duties.',
    all: true,
    designations: [],
    people: [],
  },
  {
    title: 'Professional Ethics Module',
    category: 'Ethics',
    cpd: 'Structured CPD',
    type: 'eLearning',
    provider: 'Alison',
    hours: 2.5,
    due: '2026-06-30',
    mandatory: true,
    evidence: 'certificate',
    link: 'https://alison.com',
    description: 'The five fundamental principles and how to work through an ethical conflict.',
    all: true,
    designations: [],
    people: [],
  },
  {
    title: 'IFRS 16 Leases Update',
    category: 'Structured CPD',
    cpd: 'Structured CPD',
    type: 'Webinar',
    provider: 'ICAEW',
    hours: 3,
    due: '2026-09-30',
    mandatory: false,
    evidence: 'certificate',
    link: null,
    description: 'Recognition, measurement and disclosure changes for lessee accounting.',
    all: false,
    designations: ['Senior Accountant', 'Manager', 'Director'],
    people: [],
  },
  {
    title: 'GDPR and Data Handling',
    category: 'Mandatory Compliance',
    cpd: 'Mandatory Compliance',
    type: 'eLearning',
    provider: 'Internal',
    hours: 1,
    due: '2026-04-30',
    mandatory: true,
    evidence: 'certificate',
    link: null,
    description: 'Client data classification, retention periods and breach escalation.',
    all: true,
    designations: [],
    people: [],
  },
  {
    title: 'Advanced Excel Modelling',
    category: 'Technical Skills',
    cpd: 'Unstructured CPD',
    type: 'Workshop',
    provider: 'Internal',
    hours: 4,
    due: '2026-07-31',
    mandatory: false,
    evidence: 'certificate',
    link: null,
    description: 'Three-statement models, scenario switches and audit-ready formula structure.',
    all: false,
    designations: ['Junior Accountant', 'Accountant'],
    people: [],
  },
  {
    title: 'Client Conversations',
    category: 'Soft Skills',
    cpd: 'Unstructured CPD',
    type: 'Internal Training',
    provider: 'Internal',
    hours: 2,
    due: '2026-10-31',
    mandatory: false,
    evidence: 'acknowledgement',
    link: null,
    description: 'Framing difficult findings and setting expectations early in an engagement.',
    all: true,
    designations: [],
    people: [],
  },
  {
    title: 'Corporation Tax Changes',
    category: 'Regulation & Law',
    cpd: 'Structured CPD',
    type: 'External Seminar',
    provider: 'Tolley',
    hours: 3.5,
    due: '2026-05-29',
    mandatory: true,
    evidence: 'certificate',
    link: null,
    description: 'Rate changes, associated company rules and the impact on quarterly payments.',
    all: false,
    designations: ['Accountant', 'Senior Accountant', 'Manager'],
    people: [],
  },
  {
    title: 'Audit Quality Standards',
    category: 'Structured CPD',
    cpd: 'Structured CPD',
    type: 'Online Course',
    provider: 'ACCA',
    hours: 5,
    due: '2026-11-30',
    mandatory: false,
    evidence: 'certificate',
    link: 'https://www.accaglobal.com',
    description: 'ISQM 1 in practice: engagement-level quality objectives and documentation.',
    all: false,
    designations: [],
    people: ['imoolla', 'praman'],
  },
] as const;

// [person key, item title, completed on, reflection]
const COMPLETIONS: [string, string, string, string | null][] = [
  [
    'swhitfield',
    'Anti-Money Laundering Refresh',
    '2026-02-11',
    'Applied the revised red-flag checklist to two onboarding files.',
  ],
  ['swhitfield', 'GDPR and Data Handling', '2026-03-02', null],
  ['imoolla', 'Anti-Money Laundering Refresh', '2026-01-28', null],
  [
    'imoolla',
    'Professional Ethics Module',
    '2026-03-19',
    'Ethics conflict framework now used in the engagement acceptance note.',
  ],
  ['imoolla', 'IFRS 16 Leases Update', '2026-04-08', null],
  ['glin', 'GDPR and Data Handling', '2026-03-30', null],
  ['tneri', 'Anti-Money Laundering Refresh', '2026-02-26', null],
  ['tneri', 'Professional Ethics Module', '2026-04-14', null],
  ['praman', 'Anti-Money Laundering Refresh', '2026-01-19', null],
  ['praman', 'Professional Ethics Module', '2026-02-02', null],
  [
    'praman',
    'Corporation Tax Changes',
    '2026-05-06',
    'Rate change summary circulated to the corporate team.',
  ],
];

async function main() {
  const email = (key: string) => `${key}@${domain}`;
  const idOf = new Map<string, string>();
  const one = async <T>(sql: string, params: unknown[]) => (await db.query<T>(sql, params)).rows[0];

  for (const p of PEOPLE) {
    const existing = await one<{ id: string }>('select id from profiles where lower(email) = $1', [
      email(p.key),
    ]);
    if (existing) {
      idOf.set(p.key, existing.id);
      console.log(`= ${p.name} (exists)`);
      continue;
    }
    let authUserId: string | null = null;
    try {
      authUserId = (await identity.createUser({ email: email(p.key), password: password!, fullName: p.name }))
        .authUserId;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      console.log(`  ${email(p.key)} already has an auth account - it will be linked on first sign-in.`);
    }
    const row = await one<{ id: string }>(
      `insert into profiles (full_name, email, auth_user_id, role, designation_id, reporting_access, avatar_color)
       values ($1, $2, $3, $4, (select id from designations where name = $5), $6, $7) returning id`,
      [p.name, email(p.key), authUserId, p.role, p.designation, p.access, p.color],
    );
    idOf.set(p.key, row!.id);
    console.log(`+ ${p.name} <${email(p.key)}>`);
  }
  for (const p of PEOPLE) {
    if (p.manager)
      await db.query('update profiles set line_manager_id = $2 where id = $1', [
        idOf.get(p.key),
        idOf.get(p.manager),
      ]);
  }

  const cycle = await one<{ id: string }>('select id from learning_cycles where is_current', []);
  if (!cycle) throw new Error('No current learning year - run the migrations first.');
  const admin = idOf.get('apatel')!;
  const itemIds = new Map<string, string>();
  for (const i of ITEMS) {
    const existing = await one<{ id: string }>(
      'select id from learning_items where cycle_id = $1 and title = $2',
      [cycle.id, i.title],
    );
    if (existing) {
      itemIds.set(i.title, existing.id);
      continue;
    }
    const row = await one<{ id: string }>(
      `insert into learning_items (cycle_id, title, category_id, cpd_type_id, delivery_type_id, provider, hours, due_date,
         is_mandatory, evidence_mode, link, description, assign_to_all, created_by)
       values ($1, $2, (select id from categories where name = $3), (select id from cpd_types where name = $4),
         (select id from delivery_types where name = $5), $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [
        cycle.id,
        i.title,
        i.category,
        i.cpd,
        i.type,
        i.provider,
        i.hours,
        i.due,
        i.mandatory,
        i.evidence,
        i.link,
        i.description,
        i.all,
        admin,
      ],
    );
    itemIds.set(i.title, row!.id);
    for (const d of i.designations) {
      await db.query(
        'insert into learning_item_designations (item_id, designation_id) select $1, id from designations where name = $2',
        [row!.id, d],
      );
    }
    for (const k of i.people) {
      await db.query('insert into learning_item_profiles (item_id, profile_id) values ($1, $2)', [
        row!.id,
        idOf.get(k),
      ]);
    }
    console.log(`+ item: ${i.title}`);
  }

  for (const [key, title, date, reflection] of COMPLETIONS) {
    await db.query(
      `insert into completions (profile_id, item_id, completed_on, reflection) values ($1, $2, $3, $4)
       on conflict (profile_id, item_id) do nothing`,
      [idOf.get(key), itemIds.get(title), date, reflection],
    );
  }
  console.log(
    `\nDone. Sign in with any demo email (e.g. ${email('apatel')} for the Learning Team) and your SEED_DEMO_PASSWORD.`,
  );
  console.log('Note: seeded completions have no evidence files attached.');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
