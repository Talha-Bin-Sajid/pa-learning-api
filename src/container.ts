import type { Clock } from './application/ports/clock.js';
import type { EmailSender } from './application/ports/email-sender.js';
import type { EvidenceAnalyzer } from './application/ports/evidence-analyzer.js';
import type { FileStorage } from './application/ports/file-storage.js';
import type { AuthTokenVerifier, IdentityProvider } from './application/ports/identity-provider.js';
import { ProgressSnapshotLoader } from './application/services/progress-snapshot.js';
import { AuthService } from './application/use-cases/auth.service.js';
import { CompletionsService } from './application/use-cases/completions.service.js';
import { CyclesService } from './application/use-cases/cycles.service.js';
import { EvidenceVerificationService } from './application/use-cases/evidence-verification.service.js';
import { ItemImportService } from './application/use-cases/item-import.service.js';
import { LearningItemsService } from './application/use-cases/learning-items.service.js';
import { LookupsService } from './application/use-cases/lookups.service.js';
import { PeopleService } from './application/use-cases/people.service.js';
import { ProgressService } from './application/use-cases/progress.service.js';
import { RemindersService } from './application/use-cases/reminders.service.js';
import { ReportsService } from './application/use-cases/reports.service.js';
import { UserImportService } from './application/use-cases/user-import.service.js';
import type { Env } from './infrastructure/config/env.js';
import type { Database } from './infrastructure/database/database.js';
import { LogEmailSender, SmtpEmailSender } from './infrastructure/external-services/email-senders.js';
import { ExcelWorkbook } from './infrastructure/external-services/excel-workbook.js';
import { GeminiEvidenceAnalyzer } from './infrastructure/external-services/gemini-evidence-analyzer.js';
import { SupabaseJwtVerifier } from './infrastructure/external-services/jwt-token-verifier.js';
import { ReminderScheduler } from './infrastructure/external-services/reminder-scheduler.js';
import { SupabaseFileStorage } from './infrastructure/external-services/supabase-file-storage.js';
import { SupabaseIdentityProvider } from './infrastructure/external-services/supabase-identity-provider.js';
import { SystemClock } from './infrastructure/external-services/system-clock.js';
import { VerificationWorker } from './infrastructure/external-services/verification-worker.js';
import { PgAuditLog } from './infrastructure/repositories/pg-audit-log.js';
import { PgCompletionRepository } from './infrastructure/repositories/pg-completion-repository.js';
import { PgCycleRepository } from './infrastructure/repositories/pg-cycle-repository.js';
import { PgEvidenceCheckRepository } from './infrastructure/repositories/pg-evidence-check-repository.js';
import { PgLearningItemRepository } from './infrastructure/repositories/pg-learning-item-repository.js';
import { PgLookupRepository } from './infrastructure/repositories/pg-lookup-repository.js';
import { PgPersonRepository } from './infrastructure/repositories/pg-person-repository.js';
import { PgReminderRepository } from './infrastructure/repositories/pg-reminder-repository.js';
import type { ApiServices } from './interfaces/http/routes/api-router.js';
import type { Logger } from './shared/utils/logger.js';

export interface Container {
  services: ApiServices;
  tokenVerifier: AuthTokenVerifier;
  scheduler: ReminderScheduler;
  verificationWorker: VerificationWorker;
}

/** Test seams: swap any external dependency. */
export interface ContainerOverrides {
  identity?: IdentityProvider;
  tokenVerifier?: AuthTokenVerifier;
  storage?: FileStorage;
  email?: EmailSender;
  clock?: Clock;
  /** null = no analyzer even if configured. */
  analyzer?: EvidenceAnalyzer | null;
}

/**
 * Composition root: the only place that knows concrete implementations.
 * Manual dependency injection - no container library.
 */
export function buildContainer(
  env: Env,
  db: Database,
  logger: Logger,
  overrides: ContainerOverrides = {},
): Container {
  // Repositories
  const people = new PgPersonRepository(db);
  const cycles = new PgCycleRepository(db);
  const lookups = new PgLookupRepository(db);
  const items = new PgLearningItemRepository(db);
  const completions = new PgCompletionRepository(db);
  const reminderRepo = new PgReminderRepository(db);
  const audit = new PgAuditLog(db);
  const evidenceChecks = new PgEvidenceCheckRepository(db);

  // External services
  const clock = overrides.clock ?? new SystemClock(env.APP_TIMEZONE);
  const identity =
    overrides.identity ?? new SupabaseIdentityProvider(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const tokenVerifier =
    overrides.tokenVerifier ?? new SupabaseJwtVerifier(env.SUPABASE_URL, env.SUPABASE_JWT_SECRET);
  const storage =
    overrides.storage ??
    new SupabaseFileStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.EVIDENCE_BUCKET);
  const email =
    overrides.email ??
    (env.SMTP_HOST
      ? new SmtpEmailSender({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
          from: env.MAIL_FROM,
        })
      : new LogEmailSender(logger));
  const workbook = new ExcelWorkbook();
  const analyzer =
    overrides.analyzer !== undefined
      ? overrides.analyzer
      : env.GEMINI_API_KEY
        ? new GeminiEvidenceAnalyzer(env.GEMINI_API_KEY, [env.GEMINI_MODEL, ...env.GEMINI_FALLBACK_MODELS])
        : null;

  // Application
  const snapshots = new ProgressSnapshotLoader(cycles, items, completions, people, lookups, clock, evidenceChecks);
  const verification = new EvidenceVerificationService(
    evidenceChecks,
    completions,
    items,
    cycles,
    people,
    lookups,
    storage,
    analyzer,
    audit,
    db,
    clock,
    logger,
    {
      enabled: env.AI_VERIFICATION_ENABLED,
      maxAttempts: env.AI_MAX_ATTEMPTS,
      policy: { minConfidence: env.AI_MIN_CONFIDENCE, dateToleranceDays: env.AI_DATE_TOLERANCE_DAYS },
    },
  );
  const itemsService = new LearningItemsService(items, cycles, lookups, people, audit, db);
  const remindersService = new RemindersService(
    reminderRepo,
    people,
    snapshots,
    email,
    audit,
    logger,
    env.APP_BASE_URL,
  );

  const services: ApiServices = {
    auth: new AuthService(people, lookups, cycles, identity, db, logger, {
      allowedEmailDomains: env.ALLOWED_EMAIL_DOMAINS,
    }),
    lookups: new LookupsService(lookups),
    cycles: new CyclesService(cycles, audit, db, itemsService),
    items: itemsService,
    itemImport: new ItemImportService(items, cycles, lookups, people, audit, db, workbook, workbook),
    people: new PeopleService(people, lookups, audit, db),
    userImport: new UserImportService(people, lookups, audit, db, workbook, workbook),
    progress: new ProgressService(snapshots),
    completions: new CompletionsService(
      completions,
      items,
      cycles,
      people,
      storage,
      snapshots,
      clock,
      logger,
      verification,
    ),
    verification,
    reminders: remindersService,
    reports: new ReportsService(snapshots, workbook),
  };

  const scheduler = new ReminderScheduler(reminderRepo, () => remindersService.runAutomatic(), logger);
  const verificationWorker = new VerificationWorker(verification, logger);
  return { services, tokenVerifier, scheduler, verificationWorker };
}
