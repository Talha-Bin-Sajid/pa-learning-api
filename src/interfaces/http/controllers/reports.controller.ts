import type { RequestHandler } from 'express';
import type { ReportsService } from '../../../application/use-cases/reports.service.js';
import { actorOf } from '../http-context.js';
import { sendDownload } from '../middleware/upload.js';
import { myReportParams, periodQuery, teamReportParams } from '../validators/feature.schemas.js';
import { parse } from '../validators/validate.js';

export function reportsController(reports: ReportsService) {
  const team: RequestHandler = async (req, res) => {
    const { kind } = parse(teamReportParams, req.params);
    const q = parse(periodQuery, req.query);
    sendDownload(res, await reports.team(actorOf(res), kind, q.cycleId, { from: q.from, to: q.to }));
  };

  const mine: RequestHandler = async (req, res) => {
    const { kind } = parse(myReportParams, req.params);
    const q = parse(periodQuery, req.query);
    sendDownload(res, await reports.mine(actorOf(res), kind, q.cycleId, { from: q.from, to: q.to }));
  };

  return { team, mine };
}
