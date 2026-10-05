/**
 * DEV ONLY - runs the real API against an in-memory Postgres (PGlite) seeded with
 * the prototype's people, items and completions. No Supabase needed.
 *
 *   npm run demo        → http://localhost:4000   (frontend: VITE_DEMO_MODE=true)
 *
 * Differences from production, all confined to this file:
 *  - tokens are "demo:<authUserId>" (picked on the frontend's demo sign-in screen);
 *  - evidence files live in memory and are served from /demo-files;
 *  - emails are logged, not sent;
 *  - evidence checks use an offline stand-in that reads the demo PDFs' text
 *    (set GEMINI_API_KEY in the shell to use the real Gemini model instead).
 * Refuses to start with NODE_ENV=production and listens on 127.0.0.1 only.
 */
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import type {
  EvidenceAnalyzer,
  EvidenceAnalyzerInput,
  EvidenceAnalyzerOutput,
} from '../src/application/ports/evidence-analyzer.js';
import type { FileStorage } from '../src/application/ports/file-storage.js';
import type { CheckResult } from '../src/domain/value-objects/evidence-analysis.js';
import type { AuthIdentity, AuthTokenVerifier } from '../src/application/ports/identity-provider.js';
import { buildContainer } from '../src/container.js';
import { loadEnv } from '../src/infrastructure/config/env.js';
import { createApp } from '../src/interfaces/http/app.js';
import { UnauthenticatedError } from '../src/shared/errors/app-errors.js';
import { createLogger } from '../src/shared/utils/logger.js';
import { FakeIdentityProvider } from '../tests/support/fakes.js';
import { PGliteDatabase } from '../tests/support/test-database.js';

if (process.env.NODE_ENV === 'production') throw new Error('The demo server must never run in production.');

const PORT = Number(process.env.DEMO_PORT ?? 4000);
const ORIGIN = `http://localhost:${PORT}`;
const FRONTEND = process.env.DEMO_FRONTEND_ORIGIN ?? 'http://localhost:5173';
const logger = createLogger('info');

class DemoTokenVerifier implements AuthTokenVerifier {
  async verify(token: string): Promise<AuthIdentity> {
    const [prefix, authUserId] = token.split(':');
    if (prefix !== 'demo' || !authUserId)
      throw new UnauthenticatedError('Your session has expired. Sign in again.', 'INVALID_TOKEN');
    return { authUserId, email: null };
  }
}

class MemoryStorage implements FileStorage {
  readonly files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async upload(path: string, bytes: Uint8Array, contentType: string) {
    this.files.set(path, { bytes, contentType });
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async download(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`no demo file ${path}`);
    return file.bytes;
  }
  async signedUrl(path: string) {
    return `${ORIGIN}/demo-files/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
}

/**
 * Offline stand-in for the AI: reads the text lines of simple PDFs (like the demo
 * certificates) and compares them with the claim. Images can't be read here, so
 * they come back unsure (flagged for review). Only for trying the flow locally.
 */
class DemoEvidenceAnalyzer implements EvidenceAnalyzer {
  async analyze({ bytes, mimeType, expected }: EvidenceAnalyzerInput): Promise<EvidenceAnalyzerOutput> {
    await new Promise((r) => setTimeout(r, 1500)); // feel like a real model call
    const lines =
      mimeType === 'application/pdf'
        ? [...Buffer.from(bytes).toString('latin1').matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((m) =>
            m[1]!.replace(/\\(.)/g, '$1'),
          )
        : [];
    const text = lines.join(' ');
    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    const overlap = (a: string, b: string) => {
      const A = words(a);
      const B = words(b);
      return A.size && B.size ? [...A].filter((w) => B.has(w)).length / Math.min(A.size, B.size) : 0;
    };
    const name = lines.map((l) => /^Awarded to (.+)$/i.exec(l)?.[1]?.trim()).find(Boolean) ?? null;
    const date = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
    const title = lines.find((l) => !/certificate|^(Awarded to|Completed on)/i.test(l)) ?? null;
    const score = (found: string | null, want: string): CheckResult => {
      if (!found) return 'not_found';
      const o = overlap(found, want);
      return o >= 0.99 ? 'match' : o >= 0.5 ? 'partial' : 'mismatch';
    };
    const isCertificate = lines.length > 0 && /certificate|awarded|completed/i.test(text);
    return {
      provider: 'demo',
      model: 'demo-offline-reader',
      inputTokens: null,
      outputTokens: null,
      analysis: {
        isCertificate: mimeType === 'application/pdf' ? isCertificate : true,
        documentType: isCertificate ? 'Course completion certificate' : mimeType.startsWith('image/') ? 'Image (not readable in demo mode)' : 'Unrecognised document',
        extracted: { participantName: name, courseTitle: title, provider: null, completionDate: date, hours: null, certificateId: null },
        checks: { name: score(name, expected.personName), title: score(title, expected.itemTitle), provider: 'not_found' },
        tamperingSigns: [],
        confidence: mimeType === 'application/pdf' ? 0.9 : 0.3,
        summary: isCertificate
          ? `Demo reader found "${title ?? '?'}" for ${name ?? 'an unnamed person'}${date ? ` dated ${date}` : ''}.`
          : 'Demo reader could not find certificate text in this file.',
      },
    };
  }
}

/** A one-page PDF "certificate" so the evidence viewer has something real to show. */
function certificatePdf(name: string, title: string, date: string): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = [
    'BT /F1 11 Tf 72 760 Td (PROJECT ACCOUNTANTS - DEMO CERTIFICATE) Tj ET',
    `BT /F1 24 Tf 72 700 Td (${esc(title)}) Tj ET`,
    `BT /F1 14 Tf 72 660 Td (Awarded to ${esc(name)}) Tj ET`,
    `BT /F1 12 Tf 72 636 Td (Completed on ${esc(date)}) Tj ET`,
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

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
    key: 'emarsh',
    name: 'Elena Marsh',
    role: 'hr',
    designation: 'Manager',
    access: 'full',
    color: '#6663fb',
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
  [
    'Anti-Money Laundering Refresh',
    'Mandatory Compliance',
    'Mandatory Compliance',
    'eLearning',
    'ICAEW',
    1.5,
    '2026-03-31',
    true,
    'certificate',
    'https://www.icaew.com',
    'Annual AML refresher covering client due diligence, red flags and reporting duties.',
    null,
  ],
  [
    'Professional Ethics Module',
    'Ethics',
    'Structured CPD',
    'eLearning',
    'Alison',
    2.5,
    '2026-06-30',
    true,
    'certificate',
    'https://alison.com',
    'The five fundamental principles and how to work through an ethical conflict.',
    null,
  ],
  [
    'IFRS 16 Leases Update',
    'Structured CPD',
    'Structured CPD',
    'Webinar',
    'ICAEW',
    3,
    '2026-10-30',
    false,
    'certificate',
    null,
    'Recognition, measurement and disclosure changes for lessee accounting.',
    ['Senior Accountant', 'Manager', 'Director'],
  ],
  [
    'GDPR and Data Handling',
    'Mandatory Compliance',
    'Mandatory Compliance',
    'eLearning',
    'Internal',
    1,
    '2026-04-30',
    true,
    'certificate',
    null,
    'Client data classification, retention periods and breach escalation.',
    null,
  ],
  [
    'Advanced Excel Modelling',
    'Technical Skills',
    'Unstructured CPD',
    'Workshop',
    'Internal',
    4,
    '2026-11-30',
    false,
    'certificate',
    null,
    'Three-statement models, scenario switches and audit-ready formula structure.',
    ['Junior Accountant', 'Accountant'],
  ],
  [
    'Client Conversations',
    'Soft Skills',
    'Unstructured CPD',
    'Internal Training',
    'Internal',
    2,
    '2026-10-31',
    false,
    'acknowledgement',
    null,
    'Framing difficult findings and setting expectations early in an engagement.',
    null,
  ],
  [
    'Corporation Tax Changes',
    'Regulation & Law',
    'Structured CPD',
    'External Seminar',
    'Tolley',
    3.5,
    '2026-05-29',
    true,
    'certificate',
    null,
    'Rate changes, associated company rules and the impact on quarterly payments.',
    ['Accountant', 'Senior Accountant', 'Manager'],
  ],
  [
    'Audit Quality Standards',
    'Structured CPD',
    'Structured CPD',
    'Online Course',
    'ACCA',
    5,
    '2026-12-15',
    false,
    'certificate',
    'https://www.accaglobal.com',
    'ISQM 1 in practice: engagement-level quality objectives and documentation.',
    null,
  ],
] as const;

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
  ['dokoro', 'Anti-Money Laundering Refresh', '2026-03-12', null],
  ['emarsh', 'GDPR and Data Handling', '2026-08-21', 'Updated the HR retention schedule.'],
];

async function seed(db: PGliteDatabase, storage: MemoryStorage) {
  const ids = new Map<string, { id: string; authUserId: string }>();
  for (const p of PEOPLE) {
    const authUserId = randomUUID();
    const res = await db.query<{ id: string }>(
      `insert into profiles (full_name, email, auth_user_id, role, designation_id, reporting_access, avatar_color)
       values ($1, $2, $3, $4, (select id from designations where name = $5), $6, $7) returning id`,
      [p.name, `${p.key}@projectaccountants.co.uk`, authUserId, p.role, p.designation, p.access, p.color],
    );
    ids.set(p.key, { id: res.rows[0]!.id, authUserId });
  }
  for (const p of PEOPLE)
    if (p.manager)
      await db.query('update profiles set line_manager_id = $2 where id = $1', [
        ids.get(p.key)!.id,
        ids.get(p.manager)!.id,
      ]);

  const cycle = (
    await db.query<{ id: string; year: number }>('select id, year from learning_cycles where is_current')
  ).rows[0]!;
  const itemIds = new Map<string, string>();
  for (const [
    title,
    cat,
    cpd,
    type,
    provider,
    hours,
    due,
    mandatory,
    evidence,
    link,
    description,
    designations,
  ] of ITEMS) {
    const res = await db.query<{ id: string }>(
      `insert into learning_items (cycle_id, title, category_id, cpd_type_id, delivery_type_id, provider, hours, due_date, is_mandatory,
         evidence_mode, link, description, assign_to_all, created_by)
       values ($1, $2, (select id from categories where name = $3), (select id from cpd_types where name = $4),
         (select id from delivery_types where name = $5), $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [
        cycle.id,
        title,
        cat,
        cpd,
        type,
        provider,
        hours,
        due,
        mandatory,
        evidence,
        link,
        description,
        designations === null,
        ids.get('apatel')!.id,
      ],
    );
    const id = res.rows[0]!.id;
    itemIds.set(title, id);
    for (const d of designations ?? []) {
      await db.query(
        'insert into learning_item_designations (item_id, designation_id) select $1, id from designations where name = $2',
        [id, d],
      );
    }
  }
  // Named-person audience for Audit Quality Standards.
  for (const k of ['imoolla', 'praman']) {
    await db.query('update learning_items set assign_to_all = false where id = $1', [
      itemIds.get('Audit Quality Standards'),
    ]);
    await db.query('insert into learning_item_profiles (item_id, profile_id) values ($1, $2)', [
      itemIds.get('Audit Quality Standards'),
      ids.get(k)!.id,
    ]);
  }

  for (const [key, title, date, reflection] of COMPLETIONS) {
    const person = PEOPLE.find((p) => p.key === key)!;
    const path = `${cycle.year}/${ids.get(key)!.id}/${itemIds.get(title)}/${randomUUID()}.pdf`;
    const bytes = certificatePdf(person.name, title, date);
    await storage.upload(path, bytes, 'application/pdf');
    await db.query(
      `insert into completions (profile_id, item_id, completed_on, reflection, evidence_path, evidence_file_name, evidence_mime_type, evidence_size_bytes)
       values ($1, $2, $3, $4, $5, $6, 'application/pdf', $7)`,
      [
        ids.get(key)!.id,
        itemIds.get(title),
        date,
        reflection,
        path,
        `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-certificate.pdf`,
        bytes.length,
      ],
    );
  }
}

async function main() {
  const useGemini = !!process.env.GEMINI_API_KEY;
  const env = loadEnv({
    NODE_ENV: 'development',
    DATABASE_URL: 'pglite://memory',
    SUPABASE_URL: 'http://localhost.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'demo-mode-no-service-role-key',
    APP_BASE_URL: FRONTEND,
    CORS_ORIGINS: FRONTEND,
    AI_VERIFICATION_ENABLED: 'true',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'offline-demo-reader', // placeholder; the offline reader is injected below
    GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
  });
  const db = await PGliteDatabase.create();
  const storage = new MemoryStorage();
  await seed(db, storage);

  const container = buildContainer(env, db, logger, {
    identity: new FakeIdentityProvider(),
    tokenVerifier: new DemoTokenVerifier(),
    storage,
    ...(useGemini ? {} : { analyzer: new DemoEvidenceAnalyzer() }),
  });
  // Check the seeded evidence too, so Evidence Review shows automatic results.
  await db.query(
    'insert into evidence_checks (completion_id, evidence_path) select id, evidence_path from completions where evidence_path is not null',
  );
  container.verificationWorker.start();
  const api = createApp({
    services: container.services,
    tokenVerifier: container.tokenVerifier,
    logger,
    corsOrigins: env.CORS_ORIGINS,
    rateLimits: false,
  });

  const app = express();
  app.use('/demo', cors({ origin: FRONTEND }));
  app.get('/demo/accounts', async (_req, res) => {
    const rows = await db.query<{
      auth_user_id: string;
      full_name: string;
      email: string;
      role: string;
      avatar_color: string | null;
      designation: string | null;
    }>(
      `select p.auth_user_id, p.full_name, p.email, p.role, p.avatar_color, d.name as designation
       from profiles p left join designations d on d.id = p.designation_id where p.auth_user_id is not null order by p.created_at`,
    );
    res.json(
      rows.rows.map((r) => ({
        authUserId: r.auth_user_id,
        fullName: r.full_name,
        email: r.email,
        role: r.role,
        avatarColor: r.avatar_color,
        designation: r.designation,
        initials: r.full_name
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .slice(0, 2)
          .toUpperCase(),
      })),
    );
  });
  app.get(/^\/demo-files\/(.+)$/, (req, res) => {
    const path = decodeURIComponent((req.params as unknown as string[])[0] ?? '');
    const file = storage.files.get(path);
    if (!file) return void res.status(404).end();
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(Buffer.from(file.bytes));
  });
  app.use(api);

  app.listen(PORT, '127.0.0.1', () => {
    logger.info('DEMO API ready (in-memory data, no Supabase)', {
      url: ORIGIN,
      frontend: FRONTEND,
      evidenceChecks: useGemini ? `Gemini (${env.GEMINI_MODEL})` : 'offline demo reader',
    });
  });
}

void main();
