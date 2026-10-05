import type { RequestHandler } from 'express';
import type { LookupsService } from '../../../application/use-cases/lookups.service.js';
import { ok } from '../http-context.js';

export function lookupsController(lookups: LookupsService) {
  const get: RequestHandler = async (_req, res) => {
    ok(res, await lookups.get());
  };
  return { get };
}
