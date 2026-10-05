import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Environment configuration, validated once at start-up. Secrets only ever
 * come from the environment (.env locally, the host's secret store in prod).
 */

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGINS: csv,
  TRUST_PROXY: bool(false),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** require = TLS without CA verification (Supabase pooler default); verify = TLS + CA; disable = no TLS (local only). */
  DATABASE_SSL: z.enum(['require', 'verify', 'disable']).default('require'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  SUPABASE_URL: z.url('SUPABASE_URL must be a URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  /** Only for legacy projects that sign JWTs with HS256; new projects use JWKS automatically. */
  SUPABASE_JWT_SECRET: z.string().optional().transform((v) => v || undefined),
  EVIDENCE_BUCKET: z.string().min(1).default('evidence'),

  ALLOWED_EMAIL_DOMAINS: csv.transform((list) => list.map((d) => d.toLowerCase())),
  APP_TIMEZONE: z.string().default('Europe/London'),
  APP_BASE_URL: z.url().default('http://localhost:5173'),

  SMTP_HOST: z.string().optional().transform((v) => v || undefined),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional().transform((v) => v || undefined),
  SMTP_PASS: z.string().optional().transform((v) => v || undefined),
  MAIL_FROM: z.string().default('Project Accountants Learning <learning@projectaccountants.co.uk>'),
  REMINDER_SCHEDULER_ENABLED: bool(false),

  /** Automatic evidence checks with Google Gemini (ADR 0005). Needs GEMINI_API_KEY. */
  AI_VERIFICATION_ENABLED: bool(false),
  GEMINI_API_KEY: z.string().optional().transform((v) => v || undefined),
  GEMINI_MODEL: z.string().min(1).default('gemini-flash-latest'),
  /** Tried in order when GEMINI_MODEL is overloaded (comma-separated; empty = no fallback). */
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default('gemini-flash-lite-latest')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** Below this model confidence (0-1) evidence always goes to a person. */
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  /** Allowed gap in days between the certificate date and the date the person entered. */
  AI_DATE_TOLERANCE_DAYS: z.coerce.number().int().min(0).max(365).default(14),
  /** Attempts per check before handing over to a person (retries spread over ~1.5 h). */
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(7),
});

export type Env = z.infer<typeof EnvSchema>;

/** Loads `.env` (if present) into process.env, then validates. Exits with a readable message on error. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env && existsSync('.env')) process.loadEnvFile('.env');
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example.`);
  }
  if (parsed.data.AI_VERIFICATION_ENABLED && !parsed.data.GEMINI_API_KEY) {
    throw new Error(
      'Invalid environment configuration:\n  - GEMINI_API_KEY: required when AI_VERIFICATION_ENABLED=true\nSee .env.example.',
    );
  }
  if (parsed.data.CORS_ORIGINS.length === 0) parsed.data.CORS_ORIGINS.push(parsed.data.APP_BASE_URL);
  return parsed.data;
}
