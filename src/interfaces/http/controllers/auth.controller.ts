import type { RequestHandler } from 'express';
import type { AuthService } from '../../../application/use-cases/auth.service.js';
import { actorOf, ok } from '../http-context.js';
import { registerBody } from '../validators/auth.schemas.js';
import { parse } from '../validators/validate.js';

export function authController(auth: AuthService) {
  const register: RequestHandler = async (req, res) => {
    const body = parse(registerBody, req.body);
    ok(res, { profile: await auth.register(body) }, 201);
  };

  const me: RequestHandler = async (_req, res) => {
    ok(res, await auth.me(actorOf(res)));
  };

  return { register, me };
}
