import type { CycleRepository } from '../../domain/repositories/cycle-repository.js';
import type { AuditLog } from '../../domain/repositories/audit-log.js';
import { can, type Actor } from '../../domain/services/access-policy.js';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/app-errors.js';
import type { IsoDate } from '../../shared/utils/dates.js';
import { toCycleDto, type CycleDto } from '../dto/cycle.dto.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

export interface CreateCycleInput {
  year: number;
  name?: string;
  startsOn: IsoDate;
  endsOn: IsoDate;
  makeCurrent?: boolean;
  /** Copy the (non-archived) template from this cycle, shifting due dates by the year difference. */
  copyItemsFromCycleId?: string;
}

export interface UpdateCycleInput {
  name?: string;
  startsOn?: IsoDate;
  endsOn?: IsoDate;
  makeCurrent?: boolean;
}

/** Copies a template between cycles. Implemented by the learning-items feature (wired in P2). */
export interface TemplateCopier {
  copyTemplate(fromCycleId: string, toCycleId: string, yearShift: number, actorId: string): Promise<number>;
}

export class CyclesService {
  constructor(
    private readonly cycles: CycleRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly templateCopier: TemplateCopier | null = null,
  ) {}

  async list(): Promise<CycleDto[]> {
    return (await this.cycles.list()).map(toCycleDto);
  }

  async create(actor: Actor, input: CreateCycleInput): Promise<CycleDto & { copiedItems: number }> {
    this.assertCanManage(actor);
    assertDateOrder(input.startsOn, input.endsOn);
    if (await this.cycles.findByYear(input.year)) {
      throw new ConflictError(`A ${input.year} learning year already exists.`, 'CYCLE_EXISTS');
    }

    return this.uow.run(async () => {
      let source = null;
      if (input.copyItemsFromCycleId) {
        source = await this.cycles.findById(input.copyItemsFromCycleId);
        if (!source) throw new NotFoundError('learning year', 'CYCLE_NOT_FOUND');
        if (!this.templateCopier) throw new BusinessRuleError('Copying templates is not available yet.', 'COPY_UNAVAILABLE');
      }

      const created = await this.cycles.create({
        year: input.year,
        name: input.name?.trim() || `${input.year} programme`,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
      });
      if (input.makeCurrent) await this.cycles.setCurrent(created.id);

      const copiedItems =
        source && this.templateCopier
          ? await this.templateCopier.copyTemplate(source.id, created.id, input.year - source.year, actor.id)
          : 0;

      await this.audit.record({
        actorId: actor.id,
        action: 'cycle.created',
        entityType: 'learning_cycle',
        entityId: created.id,
        metadata: { year: input.year, copiedFrom: source?.year ?? null, copiedItems },
      });
      const fresh = (await this.cycles.findById(created.id))!;
      return { ...toCycleDto(fresh), copiedItems };
    });
  }

  async update(actor: Actor, id: string, input: UpdateCycleInput): Promise<CycleDto> {
    this.assertCanManage(actor);
    return this.uow.run(async () => {
      const cycle = await this.cycles.findById(id);
      if (!cycle) throw new NotFoundError('learning year', 'CYCLE_NOT_FOUND');
      assertDateOrder(input.startsOn ?? cycle.startsOn, input.endsOn ?? cycle.endsOn);

      const changes = {
        ...(input.name !== undefined ? { name: input.name.trim() || cycle.name } : {}),
        ...(input.startsOn !== undefined ? { startsOn: input.startsOn } : {}),
        ...(input.endsOn !== undefined ? { endsOn: input.endsOn } : {}),
      };
      if (Object.keys(changes).length > 0) await this.cycles.update(id, changes);
      if (input.makeCurrent && !cycle.isCurrent) await this.cycles.setCurrent(id);

      await this.audit.record({
        actorId: actor.id,
        action: 'cycle.updated',
        entityType: 'learning_cycle',
        entityId: id,
        metadata: { ...changes, makeCurrent: input.makeCurrent ?? false },
      });
      return toCycleDto((await this.cycles.findById(id))!);
    });
  }

  private assertCanManage(actor: Actor): void {
    if (!can(actor, 'manageCycles')) throw new ForbiddenError('Only the Learning Team can manage learning years.');
  }
}

function assertDateOrder(startsOn: IsoDate, endsOn: IsoDate): void {
  if (endsOn <= startsOn) {
    throw new BusinessRuleError('The end date must be after the start date.', 'INVALID_DATE_RANGE');
  }
}
