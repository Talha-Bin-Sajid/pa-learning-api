import { buildContainer } from './container.js';
import { loadEnv } from './infrastructure/config/env.js';
import { PgDatabase } from './infrastructure/database/pg-database.js';
import { createApp } from './interfaces/http/app.js';
import { createLogger } from './shared/utils/logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const db = new PgDatabase({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    max: env.DATABASE_POOL_MAX,
  });
  await db.ping().catch((err: unknown) => {
    throw new Error(
      `Cannot reach the database. Check DATABASE_URL / DATABASE_SSL. (${(err as Error).message})`,
    );
  });

  const container = buildContainer(env, db, logger);
  const app = createApp({
    services: container.services,
    tokenVerifier: container.tokenVerifier,
    logger,
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
    healthCheck: () => db.ping(),
  });

  const server = app.listen(env.PORT, () =>
    logger.info('API listening', { port: env.PORT, env: env.NODE_ENV }),
  );
  server.on('error', (err: NodeJS.ErrnoException) => {
    const message =
      err.code === 'EADDRINUSE'
        ? `Port ${env.PORT} is already in use - another copy of the API (or the demo server) is running. Stop it or set PORT in .env.`
        : `Server error: ${err.message}`;
    process.stderr.write(`${message}\n`);
    void db.close().finally(() => process.exit(1));
  });
  if (env.REMINDER_SCHEDULER_ENABLED) container.scheduler.start();
  if (env.AI_VERIFICATION_ENABLED) container.verificationWorker.start();

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    container.scheduler.stop();
    container.verificationWorker.stop();
    server.close(() => {
      void db.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
