import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { EvidenceAnalyzer } from '../../src/application/ports/evidence-analyzer.js';
import { buildContainer, type Container } from '../../src/container.js';
import type { ProfileStatus, ReportingAccess, UserRole } from '../../src/domain/enums.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { createApp } from '../../src/interfaces/http/app.js';
import { silentLogger } from '../../src/shared/utils/logger.js';
import { FakeEmailSender, FakeFileStorage, FakeIdentityProvider, FakeTokenVerifier, FixedClock, tokenFor } from './fakes.js';
import { PGliteDatabase } from './test-database.js';

const testEnvSource = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-not-real',
  ALLOWED_EMAIL_DOMAINS: '',
  APP_BASE_URL: 'http://localhost:5173',
};
export const testEnv = loadEnv({ ...testEnvSource });

export interface Signed {
  id: string;
  auth: string;
}

export interface TestApp {
  app: Express;
  db: PGliteDatabase;
  container: Container;
  identity: FakeIdentityProvider;
  storage: FakeFileStorage;
  email: FakeEmailSender;
  clock: FixedClock;
  /** Inserts a person with a linked auth account and returns an Authorization header for them. */
  signInAs(opts: SeedPersonOptions): Promise<Signed>;
  close(): Promise<void>;
}

export interface SeedPersonOptions {
  email: string;
  fullName?: string;
  role?: UserRole;
  reportingAccess?: ReportingAccess;
  status?: ProfileStatus;
  lineManagerId?: string | null;
  designation?: string | null;
  linked?: boolean;
}

export async function seedPerson(db: PGliteDatabase, o: SeedPersonOptions): Promise<{ id: string; authUserId: string | null }> {
  const authUserId = o.linked === false ? null : randomUUID();
  const res = await db.query<{ id: string }>(
    `insert into profiles (full_name, email, auth_user_id, role, reporting_access, status, line_manager_id, designation_id)
     values ($1, $2, $3, $4, $5, $6, $7, (select id from designations where name = $8)) returning id`,
    [
      o.fullName ?? o.email.split('@')[0],
      o.email,
      authUserId,
      o.role ?? 'team_member',
      o.reportingAccess ?? 'self',
      o.status ?? 'active',
      o.lineManagerId ?? null,
      o.designation ?? null,
    ],
  );
  return { id: res.rows[0]!.id, authUserId };
}

export interface TestAppOptions {
  /** Extra env vars (e.g. AI_VERIFICATION_ENABLED). */
  env?: Record<string, string>;
  analyzer?: EvidenceAnalyzer | null;
}

export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const db = await PGliteDatabase.create();
  const identity = new FakeIdentityProvider();
  const storage = new FakeFileStorage();
  const email = new FakeEmailSender();
  const clock = new FixedClock();
  const env = opts.env ? loadEnv({ ...testEnvSource, ...opts.env }) : testEnv;
  const container = buildContainer(env, db, silentLogger, {
    analyzer: opts.analyzer ?? null,
    identity,
    tokenVerifier: new FakeTokenVerifier(),
    storage,
    email,
    clock,
  });
  const app = createApp({
    services: container.services,
    tokenVerifier: container.tokenVerifier,
    logger: silentLogger,
    corsOrigins: ['http://localhost:5173'],
    rateLimits: false,
  });
  return {
    app,
    db,
    container,
    identity,
    storage,
    email,
    clock,
    async signInAs(opts) {
      const { id, authUserId } = await seedPerson(db, opts);
      return { id, auth: tokenFor(authUserId!, opts.email) };
    },
    close: () => db.close(),
  };
}

/** Lookup ids by name, for building request bodies. */
export async function lookupIds(db: PGliteDatabase) {
  const q = async (table: string) => {
    const res = await db.query<{ id: number; name: string }>(`select id, name from ${table}`);
    return Object.fromEntries(res.rows.map((r) => [r.name, r.id])) as Record<string, number>;
  };
  return {
    designations: await q('designations'),
    categories: await q('categories'),
    cpdTypes: await q('cpd_types'),
    deliveryTypes: await q('delivery_types'),
  };
}

/** Minimal valid files for upload tests. */
export const FILES = {
  pdf: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF'),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  exeRenamed: Buffer.from('MZ\x90\x00 this is not a pdf'),
};
