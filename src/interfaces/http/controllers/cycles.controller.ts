import type { RequestHandler } from 'express';
import type { CyclesService } from '../../../application/use-cases/cycles.service.js';
import { actorOf, ok } from '../http-context.js';
import { idParams } from '../validators/common.schemas.js';
import { createCycleBody, updateCycleBody } from '../validators/cycles.schemas.js';
import { parse } from '../validators/validate.js';

export function cyclesController(cycles: CyclesService) {
  const list: RequestHandler = async (_req, res) => {
    ok(res, await cycles.list());
  };

  const create: RequestHandler = async (req, res) => {
    ok(res, await cycles.create(actorOf(res), parse(createCycleBody, req.body)), 201);
  };

  const update: RequestHandler = async (req, res) => {
    const { id } = parse(idParams, req.params);
    ok(res, await cycles.update(actorOf(res), id, parse(updateCycleBody, req.body)));
  };

  return { list, create, update };
}
