import { Router, type RequestHandler } from 'express';
import type { AuthTokenVerifier } from '../../../application/ports/identity-provider.js';
import type { AuthService } from '../../../application/use-cases/auth.service.js';
import type { CompletionsService } from '../../../application/use-cases/completions.service.js';
import type { CyclesService } from '../../../application/use-cases/cycles.service.js';
import type { EvidenceVerificationService } from '../../../application/use-cases/evidence-verification.service.js';
import type { ItemImportService } from '../../../application/use-cases/item-import.service.js';
import type { LearningItemsService } from '../../../application/use-cases/learning-items.service.js';
import type { LookupsService } from '../../../application/use-cases/lookups.service.js';
import type { PeopleService } from '../../../application/use-cases/people.service.js';
import type { ProgressService } from '../../../application/use-cases/progress.service.js';
import type { RemindersService } from '../../../application/use-cases/reminders.service.js';
import type { ReportsService } from '../../../application/use-cases/reports.service.js';
import type { UserImportService } from '../../../application/use-cases/user-import.service.js';
import { authController } from '../controllers/auth.controller.js';
import { cyclesController } from '../controllers/cycles.controller.js';
import { learningItemsController } from '../controllers/learning-items.controller.js';
import { learningController } from '../controllers/learning.controller.js';
import { lookupsController } from '../controllers/lookups.controller.js';
import { peopleController } from '../controllers/people.controller.js';
import { remindersController } from '../controllers/reminders.controller.js';
import { reportsController } from '../controllers/reports.controller.js';
import { authenticate, requireCapability } from '../middleware/authenticate.js';
import { evidenceUpload, spreadsheetUpload } from '../middleware/upload.js';

export interface ApiServices {
  auth: AuthService;
  lookups: LookupsService;
  cycles: CyclesService;
  items: LearningItemsService;
  itemImport: ItemImportService;
  people: PeopleService;
  userImport: UserImportService;
  progress: ProgressService;
  completions: CompletionsService;
  verification: EvidenceVerificationService;
  reminders: RemindersService;
  reports: ReportsService;
}

export interface ApiRouterDeps {
  services: ApiServices;
  tokenVerifier: AuthTokenVerifier;
  /** Stricter limiter for abuse-prone endpoints (registration, sending emails). */
  strictLimiter: RequestHandler;
}

/**
 * /api/v1 routes. Capability guards here give fast 403s; services re-check
 * authorization and apply visibility scoping, so no route relies on the UI.
 */
export function apiRouter({ services: s, tokenVerifier, strictLimiter }: ApiRouterDeps): Router {
  const r = Router();
  const auth = authController(s.auth);
  const lookups = lookupsController(s.lookups);
  const cycles = cyclesController(s.cycles);
  const items = learningItemsController(s.items, s.itemImport);
  const people = peopleController(s.people, s.userImport);
  const learning = learningController(s.progress, s.completions, s.verification);
  const reminders = remindersController(s.reminders);
  const reports = reportsController(s.reports);
  const admin = (cap: Parameters<typeof requireCapability>[0]) => requireCapability(cap);

  // ---- public ----
  r.post('/auth/register', strictLimiter, auth.register);

  // ---- everything below requires a signed-in, active person ----
  r.use(authenticate(tokenVerifier, s.auth));

  r.get('/me', auth.me);
  r.get('/lookups', lookups.get);

  // Learning years
  r.get('/cycles', cycles.list);
  r.post('/cycles', admin('manageCycles'), cycles.create);
  r.patch('/cycles/:id', admin('manageCycles'), cycles.update);

  // Learning template (static paths before /:id)
  r.get('/items', items.list);
  r.get('/items/import/template', admin('manageItems'), items.template);
  r.post('/items/import/preview', admin('manageItems'), spreadsheetUpload, items.previewImport);
  r.post('/items/import', admin('manageItems'), items.commitImport);
  r.get('/items/:id', admin('manageItems'), items.get);
  r.post('/items', admin('manageItems'), items.create);
  r.put('/items/:id', admin('manageItems'), items.update);
  r.delete('/items/:id', admin('manageItems'), items.archive);

  // User management
  r.get('/users', admin('manageUsers'), people.list);
  r.get('/users/import/template', admin('manageUsers'), people.template);
  r.post('/users/import/preview', admin('manageUsers'), spreadsheetUpload, people.previewImport);
  r.post('/users/import', admin('manageUsers'), people.commitImport);
  r.post('/users', admin('manageUsers'), people.create);
  r.patch('/users', admin('manageUsers'), people.bulkUpdate);
  r.patch('/users/:id', admin('manageUsers'), people.update);

  // Progress (scoped to the actor's visibility)
  r.get('/progress/overview', admin('viewTeam'), learning.overview);
  r.get('/progress/members', admin('viewTeam'), learning.members);
  r.get('/progress/members/:profileId', learning.member);

  // My learning
  r.get('/me/plan', learning.myPlan);
  r.get('/me/completions', learning.myEvidence);
  r.put('/me/completions/:itemId', evidenceUpload, learning.submit);

  // Evidence
  r.get('/completions', admin('reviewEvidence'), learning.register);
  r.get('/completions/:id/evidence-url', learning.evidenceUrl);
  r.post('/completions/:id/review', admin('decideEvidence'), learning.decide);
  r.post('/completions/:id/recheck', admin('decideEvidence'), strictLimiter, learning.recheck);

  // Reminders
  r.get('/reminders/settings', admin('manageReminders'), reminders.settings);
  r.put('/reminders/settings', admin('manageReminders'), reminders.updateSettings);
  r.get('/reminders/candidates', admin('manageReminders'), reminders.candidates);
  r.post('/reminders/send', admin('manageReminders'), strictLimiter, reminders.send);
  r.get('/reminders/log', admin('manageReminders'), reminders.log);

  // Reports
  r.get('/reports/team/:kind', admin('viewTeam'), reports.team);
  r.get('/reports/me/:kind', reports.mine);

  return r;
}
