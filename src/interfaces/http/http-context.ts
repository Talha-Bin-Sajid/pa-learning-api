import type { Request, Response } from 'express';
import type { Person } from '../../domain/entities/person.js';
import { UnauthenticatedError } from '../../shared/errors/app-errors.js';

/** Per-request state set by middleware. Kept in res.locals to avoid global type augmentation. */
export interface RequestLocals {
  requestId: string;
  actor?: Person;
}

export function locals(res: Response): RequestLocals {
  return res.locals as RequestLocals;
}

/** The authenticated person. Only valid behind the `authenticate` middleware. */
export function actorOf(res: Response): Person {
  const actor = locals(res).actor;
  if (!actor) throw new UnauthenticatedError();
  return actor;
}

/** Standard success envelope. */
export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}
