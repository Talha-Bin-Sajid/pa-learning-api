import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { AuthTokenVerifier } from '../../application/ports/identity-provider.js';
import type { Logger } from '../../shared/utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import { apiRouter, type ApiServices } from './routes/api-router.js';

export interface AppDeps {
  services: ApiServices;
  tokenVerifier: AuthTokenVerifier;
  logger: Logger;
  corsOrigins: string[];
  trustProxy?: boolean;
  /** Health probe for the database (optional in tests). */
  healthCheck?: () => Promise<void>;
  /** Disable rate limits (tests). */
  rateLimits?: boolean;
}

const limitResponse = {
  success: false,
  message: 'Too many requests. Please wait and try again.',
  code: 'RATE_LIMITED',
};

/** Builds the Express app. Pure wiring - no business logic. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  if (deps.trustProxy) app.set('trust proxy', 1);

  app.use(requestId(deps.logger));
  app.use(helmet());
  app.use(
    cors({
      origin: deps.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  const enabled = deps.rateLimits !== false;
  const globalLimiter = rateLimit({
    windowMs: 60_000,
    limit: enabled ? 300 : 0,
    skip: () => !enabled,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: limitResponse,
  });
  const strictLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: enabled ? 10 : 0,
    skip: () => !enabled,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: limitResponse,
  });

  app.get('/health', async (_req, res) => {
    try {
      await deps.healthCheck?.();
      res.json({ success: true, data: { status: 'ok' } });
    } catch {
      res.status(503).json({ success: false, message: 'Database unavailable.', code: 'UNHEALTHY' });
    }
  });

  app.use(
    '/api/v1',
    globalLimiter,
    apiRouter({ services: deps.services, tokenVerifier: deps.tokenVerifier, strictLimiter }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
