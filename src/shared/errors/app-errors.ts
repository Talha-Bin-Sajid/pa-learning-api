/**
 * Framework-agnostic error types. The HTTP layer maps each kind to a status
 * code (see interfaces/http/middleware/error-handler.ts); inner layers never
 * think in HTTP terms.
 */

export interface ErrorDetail {
  path: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly kind:
    | 'validation'
    | 'unauthenticated'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'business_rule'
    | 'payload_too_large'
    | 'unsupported_media'
    | 'external_service';

  constructor(
    message: string,
    readonly code: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  readonly kind = 'validation' as const;
  constructor(message = 'The request is invalid.', details?: ErrorDetail[], code = 'VALIDATION_ERROR') {
    super(message, code, details);
  }
}

export class UnauthenticatedError extends AppError {
  readonly kind = 'unauthenticated' as const;
  constructor(message = 'Sign in to continue.', code = 'UNAUTHENTICATED') {
    super(message, code);
  }
}

export class ForbiddenError extends AppError {
  readonly kind = 'forbidden' as const;
  constructor(message = 'You do not have access to this.', code = 'FORBIDDEN') {
    super(message, code);
  }
}

export class NotFoundError extends AppError {
  readonly kind = 'not_found' as const;
  constructor(entity: string, code = `${entity.toUpperCase().replace(/\s+/g, '_')}_NOT_FOUND`) {
    super(`${entity.charAt(0).toUpperCase()}${entity.slice(1)} not found.`, code);
  }
}

export class ConflictError extends AppError {
  readonly kind = 'conflict' as const;
  constructor(message: string, code = 'CONFLICT') {
    super(message, code);
  }
}

/** A well-formed request that breaks a domain rule (e.g. completing an unassigned item). */
export class BusinessRuleError extends AppError {
  readonly kind = 'business_rule' as const;
  constructor(message: string, code: string) {
    super(message, code);
  }
}

export class PayloadTooLargeError extends AppError {
  readonly kind = 'payload_too_large' as const;
  constructor(message = 'The file is too large.', code = 'FILE_TOO_LARGE') {
    super(message, code);
  }
}

export class UnsupportedMediaError extends AppError {
  readonly kind = 'unsupported_media' as const;
  constructor(message = 'This file type is not supported.', code = 'UNSUPPORTED_FILE_TYPE') {
    super(message, code);
  }
}

/** A dependency (auth provider, storage, mail) failed. Message is safe to show; cause is logged only. */
export class ExternalServiceError extends AppError {
  readonly kind = 'external_service' as const;
  constructor(
    message: string,
    code = 'EXTERNAL_SERVICE_ERROR',
    readonly causeDetail?: unknown,
  ) {
    super(message, code);
  }
}
