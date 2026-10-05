import type { z } from 'zod';
import { ValidationError } from '../../../shared/errors/app-errors.js';

/** Parses untrusted input at the HTTP boundary; throws a ValidationError with field details. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
  const first = details[0];
  throw new ValidationError(first ? `${first.path}: ${first.message}` : 'The request is invalid.', details);
}
