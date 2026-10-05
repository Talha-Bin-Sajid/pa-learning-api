import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../../../shared/utils/logger.js';
import { locals } from '../http-context.js';

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Assigns a request id (or accepts a sane upstream one) and logs one line per request. */
export function requestId(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    locals(res).requestId = id;
    res.setHeader('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info('request', {
        requestId: id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(ms),
        actorId: locals(res).actor?.id,
      });
    });
    next();
  };
}
