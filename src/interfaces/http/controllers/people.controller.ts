import type { RequestHandler } from 'express';
import type { PeopleService } from '../../../application/use-cases/people.service.js';
import type { UserImportService } from '../../../application/use-cases/user-import.service.js';
import { actorOf, ok } from '../http-context.js';
import { requireFile, sendDownload } from '../middleware/upload.js';
import { idParams } from '../validators/common.schemas.js';
import { peopleBulkBody, peopleListQuery, personBody, personPatchBody, userImportBody } from '../validators/feature.schemas.js';
import { parse } from '../validators/validate.js';

export function peopleController(people: PeopleService, imports: UserImportService) {
  const list: RequestHandler = async (req, res) => {
    ok(res, await people.list(actorOf(res), parse(peopleListQuery, req.query)));
  };

  const create: RequestHandler = async (req, res) => {
    ok(res, await people.create(actorOf(res), parse(personBody, req.body)), 201);
  };

  const update: RequestHandler = async (req, res) => {
    const { id } = parse(idParams, req.params);
    ok(res, await people.update(actorOf(res), id, parse(personPatchBody, req.body)));
  };

  const bulkUpdate: RequestHandler = async (req, res) => {
    ok(res, await people.bulkUpdate(actorOf(res), parse(peopleBulkBody, req.body).updates));
  };

  const template: RequestHandler = async (_req, res) => {
    sendDownload(res, await imports.template(actorOf(res)));
  };

  const previewImport: RequestHandler = async (req, res) => {
    const file = requireFile(req.file);
    ok(res, await imports.preview(actorOf(res), file.buffer, file.originalname));
  };

  const commitImport: RequestHandler = async (req, res) => {
    ok(res, await imports.commit(actorOf(res), parse(userImportBody, req.body).rows), 201);
  };

  return { list, create, update, bulkUpdate, template, previewImport, commitImport };
}
