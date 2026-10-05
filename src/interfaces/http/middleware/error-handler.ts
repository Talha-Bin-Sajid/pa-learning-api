import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, ExternalServiceError } from '../../../shared/errors/app-errors.js';
import type { Logger } from '../../../shared/utils/logger.js';
import { locals } from '../http-context.js';

const STATUS: Record<AppError['kind'], number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media: 415,
  business_rule: 422,
  external_service: 502,
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.', code: 'ROUTE_NOT_FOUND' });
};

/**
 * Single place that turns errors into the response envelope. Known AppErrors
 * keep their safe message; anything else becomes a generic 500 and is logged
 * with the request id - internals never reach the client.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const requestId = locals(res).requestId;

    if (err instanceof AppError) {
      if (err instanceof ExternalServiceError) {
        logger.error('external service error', { requestId, code: err.code, cause: err.causeDetail });
      }
      res.status(STATUS[err.kind]).json({
        success: false,
        message: err.message,
        code: err.code,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }

    // Body-parser errors (malformed JSON, body too large) carry a status/type.
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res
        .status(400)
        .json({ success: false, message: 'The request body is not valid JSON.', code: 'INVALID_JSON' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res
        .status(413)
        .json({ success: false, message: 'The request is too large.', code: 'PAYLOAD_TOO_LARGE' });
      return;
    }

    logger.error('unhandled error', { requestId, err });
    res.status(500).json({
      success: false,
      message: 'Something went wrong. Please try again.',
      code: 'INTERNAL_ERROR',
      requestId,
    });
  };
}
