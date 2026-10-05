import type { Completion } from '../../domain/entities/completion.js';
import type { LearningCycle } from '../../domain/entities/learning-cycle.js';
import type { LearningItem } from '../../domain/entities/learning-item.js';
import type { Lookups } from '../../domain/entities/lookups.js';
import type { Person } from '../../domain/entities/person.js';
import type { EvidenceCheck } from '../../domain/entities/evidence-check.js';
import type { CompletionRepository } from '../../domain/repositories/completion-repository.js';
import type { EvidenceCheckRepository } from '../../domain/repositories/evidence-check-repository.js';
import type { CycleRepository } from '../../domain/repositories/cycle-repository.js';
import type { LearningItemRepository } from '../../domain/repositories/learning-item-repository.js';
import type { LookupRepository } from '../../domain/repositories/lookup-repository.js';
import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import { visibilityScope, type Actor } from '../../domain/services/access-policy.js';
import { LearningProgress } from '../../domain/services/learning-progress.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/app-errors.js';
import type { PersonDtoContext } from '../dto/person.dto.js';
import type { Clock } from '../ports/clock.js';

/** Everything needed to answer "who has done what" for one learning year. */
export interface ProgressSnapshot {
  cycle: LearningCycle;
  /** Items of the cycle, including archived ones (so historic completions still resolve). */
  items: LearningItem[];
  itemsById: Map<string, LearningItem>;
  completions: Completion[];
  /** Latest automated evidence check per completion id. */
  checks: Map<string, EvidenceCheck>;
  /** All profiles (any status) - for names; use `activePeople` for progress. */
  people: Person[];
  peopleById: Map<string, Person>;
  activePeople: Person[];
  lookups: Lookups;
  dtoContext: PersonDtoContext;
  progress: LearningProgress;
  today: string;
}

export class ProgressSnapshotLoader {
  constructor(
    private readonly cycles: CycleRepository,
    private readonly items: LearningItemRepository,
    private readonly completions: CompletionRepository,
    private readonly people: PersonRepository,
    private readonly lookups: LookupRepository,
    private readonly clock: Clock,
    private readonly evidenceChecks: EvidenceCheckRepository,
  ) {}

  async resolveCycle(cycleId?: string | null): Promise<LearningCycle> {
    if (cycleId) {
      const cycle = await this.cycles.findById(cycleId);
      if (!cycle) throw new NotFoundError('learning year', 'CYCLE_NOT_FOUND');
      return cycle;
    }
    const current = await this.cycles.findCurrent();
    if (!current)
      throw new BusinessRuleError(
        'No learning year is set as current. Create one first.',
        'NO_CURRENT_CYCLE',
      );
    return current;
  }

  async load(cycleId?: string | null): Promise<ProgressSnapshot> {
    const cycle = await this.resolveCycle(cycleId);
    const [items, completions, people, lookups] = await Promise.all([
      this.items.listByCycle(cycle.id, { includeArchived: true }),
      this.completions.listByCycle(cycle.id),
      this.people.list(),
      this.lookups.all(),
    ]);
    const checks = await this.evidenceChecks.latestFor(completions.filter((c) => c.evidence).map((c) => c.id));
    const today = this.clock.today();
    const peopleById = new Map(people.map((p) => [p.id, p]));
    return {
      cycle,
      items,
      itemsById: new Map(items.map((i) => [i.id, i])),
      completions,
      checks,
      people,
      peopleById,
      activePeople: people.filter((p) => p.status === 'active'),
      lookups,
      dtoContext: { designations: new Map(lookups.designations.map((d) => [d.id, d])), peopleById },
      progress: new LearningProgress(items, completions, today),
      today,
    };
  }
}

/**
 * Active people whose learning `actor` may see on team pages, limited to those
 * with at least one assigned item (decision D4: everyone with learning counts).
 *   scope all  → everyone
 *   scope team → direct reports
 *   scope self → nobody (team pages are not available)
 */
export function visibleLearners(actor: Actor, snapshot: ProgressSnapshot): Person[] {
  const scope = visibilityScope(actor);
  if (scope === 'self') return [];
  return snapshot.activePeople.filter(
    (p) => (scope === 'all' || p.lineManagerId === actor.id) && snapshot.progress.assignedItems(p).length > 0,
  );
}
