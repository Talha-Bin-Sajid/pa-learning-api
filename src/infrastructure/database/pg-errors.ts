/** Helpers for recognising Postgres error codes (works for node-postgres and PGlite errors). */

interface PgLikeError {
  code?: string;
  constraint?: string;
}

function asPgError(err: unknown): PgLikeError {
  return typeof err === 'object' && err !== null ? (err as PgLikeError) : {};
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = asPgError(err);
  return e.code === '23505' && (!constraint || e.constraint === constraint);
}

export function isForeignKeyViolation(err: unknown): boolean {
  return asPgError(err).code === '23503';
}

export function isCheckViolation(err: unknown): boolean {
  return asPgError(err).code === '23514';
}
