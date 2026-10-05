import type { RequestHandler } from 'express';
import type { AuthTokenVerifier } from '../../../application/ports/identity-provider.js';
import type { AuthService } from '../../../application/use-cases/auth.service.js';
import { can, type Capability } from '../../../domain/services/access-policy.js';
import { ForbiddenError, UnauthenticatedError } from '../../../shared/errors/app-errors.js';
import { actorOf, bearerToken, locals } from '../http-context.js';

/** Verifies the Supabase JWT and loads the active Person as the request actor. */
export function authenticate(verifier: AuthTokenVerifier, auth: AuthService): RequestHandler {
  return async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) throw new UnauthenticatedError();
    const identity = await verifier.verify(token);
    locals(res).actor = await auth.resolveActor(identity);
    next();
  };
}

/** Route guard for a capability from the access policy. */
export function requireCapability(capability: Capability): RequestHandler {
  return (_req, res, next) => {
    if (!can(actorOf(res), capability)) throw new ForbiddenError();
    next();
  };
}
