import type { RequestHandler } from 'express';
import type { RemindersService } from '../../../application/use-cases/reminders.service.js';
import { actorOf, ok } from '../http-context.js';
import { reminderLogQuery, reminderSettingsBody, sendRemindersBody } from '../validators/feature.schemas.js';
import { parse } from '../validators/validate.js';

export function remindersController(reminders: RemindersService) {
  const settings: RequestHandler = async (_req, res) => {
    ok(res, await reminders.settings(actorOf(res)));
  };

  const updateSettings: RequestHandler = async (req, res) => {
    ok(res, await reminders.updateSettings(actorOf(res), parse(reminderSettingsBody, req.body)));
  };

  const candidates: RequestHandler = async (_req, res) => {
    ok(res, await reminders.candidates(actorOf(res)));
  };

  const send: RequestHandler = async (req, res) => {
    const body = parse(sendRemindersBody, req.body);
    ok(res, await reminders.sendManual(actorOf(res), body.profileIds, body.message));
  };

  const log: RequestHandler = async (req, res) => {
    ok(res, await reminders.log(actorOf(res), parse(reminderLogQuery, req.query).limit));
  };

  return { settings, updateSettings, candidates, send, log };
}
