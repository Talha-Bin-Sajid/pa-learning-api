import type { RequestHandler } from 'express';
import type { CompletionsService } from '../../../application/use-cases/completions.service.js';
import type { EvidenceVerificationService } from '../../../application/use-cases/evidence-verification.service.js';
import type { ProgressService } from '../../../application/use-cases/progress.service.js';
import { actorOf, ok } from '../http-context.js';
import { idParams } from '../validators/common.schemas.js';
import { completionFields, cycleQuery, evidenceDecisionBody, evidenceRegisterQuery, itemIdParams, profileIdParams } from '../validators/feature.schemas.js';
import { parse } from '../validators/validate.js';

/** Progress (dashboard, team, plans) and completions/evidence. */
export function learningController(
  progress: ProgressService,
  completions: CompletionsService,
  verification: EvidenceVerificationService,
) {
  const overview: RequestHandler = async (req, res) => {
    ok(res, await progress.overview(actorOf(res), parse(cycleQuery, req.query).cycleId));
  };

  const members: RequestHandler = async (req, res) => {
    ok(res, await progress.members(actorOf(res), parse(cycleQuery, req.query).cycleId));
  };

  const member: RequestHandler = async (req, res) => {
    const { profileId } = parse(profileIdParams, req.params);
    ok(res, await progress.member(actorOf(res), profileId, parse(cycleQuery, req.query).cycleId));
  };

  const myPlan: RequestHandler = async (req, res) => {
    ok(res, await progress.myPlan(actorOf(res), parse(cycleQuery, req.query).cycleId));
  };

  const submit: RequestHandler = async (req, res) => {
    const { itemId } = parse(itemIdParams, req.params);
    const fields = parse(completionFields, req.body);
    const result = await completions.submit(actorOf(res), itemId, {
      ...fields,
      file: req.file ? { bytes: req.file.buffer, originalName: req.file.originalname } : null,
    });
    ok(res, result.completion, result.created ? 201 : 200);
  };

  const myEvidence: RequestHandler = async (req, res) => {
    ok(res, await completions.mine(actorOf(res), parse(cycleQuery, req.query).cycleId));
  };

  const register: RequestHandler = async (req, res) => {
    const q = parse(evidenceRegisterQuery, req.query);
    ok(res, await completions.register(actorOf(res), q.cycleId, { from: q.from, to: q.to }, q.profileId));
  };

  const evidenceUrl: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await completions.evidenceUrl(actorOf(res), parse(idParams, req.params).id));
  };

  const decide: RequestHandler = async (req, res) => {
    const { decision, note } = parse(evidenceDecisionBody, req.body);
    ok(res, await verification.decide(actorOf(res), parse(idParams, req.params).id, decision, note));
  };

  const recheck: RequestHandler = async (req, res) => {
    ok(res, await verification.recheck(actorOf(res), parse(idParams, req.params).id), 202);
  };

  return { overview, members, member, myPlan, submit, myEvidence, register, evidenceUrl, decide, recheck };
}
