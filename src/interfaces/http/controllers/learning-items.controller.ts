import type { RequestHandler } from 'express';
import type { ItemImportService } from '../../../application/use-cases/item-import.service.js';
import type { LearningItemsService } from '../../../application/use-cases/learning-items.service.js';
import { actorOf, ok } from '../http-context.js';
import { requireFile, sendDownload } from '../middleware/upload.js';
import { idParams } from '../validators/common.schemas.js';
import { itemBody, itemImportBody, itemListQuery } from '../validators/feature.schemas.js';
import { parse } from '../validators/validate.js';

export function learningItemsController(items: LearningItemsService, imports: ItemImportService) {
  const list: RequestHandler = async (req, res) => {
    const q = parse(itemListQuery, req.query);
    ok(res, await items.list(actorOf(res), q.cycleId, q.includeArchived));
  };

  const get: RequestHandler = async (req, res) => {
    ok(res, await items.get(actorOf(res), parse(idParams, req.params).id));
  };

  const create: RequestHandler = async (req, res) => {
    ok(res, await items.create(actorOf(res), parse(itemBody, req.body)), 201);
  };

  const update: RequestHandler = async (req, res) => {
    const { id } = parse(idParams, req.params);
    ok(res, await items.update(actorOf(res), id, parse(itemBody, req.body)));
  };

  const archive: RequestHandler = async (req, res) => {
    await items.archive(actorOf(res), parse(idParams, req.params).id);
    res.status(204).end();
  };

  const template: RequestHandler = async (_req, res) => {
    sendDownload(res, await imports.template(actorOf(res)));
  };

  const previewImport: RequestHandler = async (req, res) => {
    const file = requireFile(req.file);
    ok(res, await imports.preview(actorOf(res), file.buffer, file.originalname));
  };

  const commitImport: RequestHandler = async (req, res) => {
    const body = parse(itemImportBody, req.body);
    ok(res, await imports.commit(actorOf(res), body.cycleId, body.rows), 201);
  };

  return { list, get, create, update, archive, template, previewImport, commitImport };
}
