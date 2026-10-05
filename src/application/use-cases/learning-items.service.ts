import type { LearningItemFields, NewLearningItem } from '../../domain/entities/learning-item.js';
import type { Lookups } from '../../domain/entities/lookups.js';
import type { EvidenceMode } from '../../domain/enums.js';
import type { AuditLog } from '../../domain/repositories/audit-log.js';
import type { CycleRepository } from '../../domain/repositories/cycle-repository.js';
import type { LearningItemRepository } from '../../domain/repositories/learning-item-repository.js';
import type { LookupRepository } from '../../domain/repositories/lookup-repository.js';
import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import { can, type Actor } from '../../domain/services/access-policy.js';
import { toAudience } from '../../domain/value-objects/audience.js';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError, type ErrorDetail } from '../../shared/errors/app-errors.js';
import { addYears, type IsoDate } from '../../shared/utils/dates.js';
import { toLearningItemDto, type LearningItemDto } from '../dto/learning-item.dto.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { TemplateCopier } from './cycles.service.js';

export interface LearningItemInput {
  cycleId?: string;
  title: string;
  categoryId: number;
  cpdTypeId: number;
  deliveryTypeId: number;
  provider?: string | null;
  hours: number;
  dueDate?: IsoDate | null;
  isMandatory: boolean;
  evidenceMode: EvidenceMode;
  link?: string | null;
  description?: string | null;
  audience: { all: boolean; designationIds?: number[]; profileIds?: string[] };
}

export class LearningItemsService implements TemplateCopier {
  constructor(
    private readonly items: LearningItemRepository,
    private readonly cycles: CycleRepository,
    private readonly lookups: LookupRepository,
    private readonly people: PersonRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  /** The Learning Template of a cycle. Visible to admins, HR and anyone with team visibility. */
  async list(actor: Actor, cycleId?: string, includeArchived = false): Promise<LearningItemDto[]> {
    if (!can(actor, 'manageItems') && !can(actor, 'viewTeam') && !can(actor, 'reviewEvidence')) {
      throw new ForbiddenError();
    }
    const cycle = await this.cycleOrCurrent(cycleId);
    const [items, ctx] = await Promise.all([this.items.listByCycle(cycle.id, { includeArchived }), this.dtoContext()]);
    return items.map((i) => toLearningItemDto(i, ctx));
  }

  async get(actor: Actor, id: string): Promise<LearningItemDto> {
    if (!can(actor, 'manageItems')) throw new ForbiddenError();
    const item = await this.items.findById(id);
    if (!item) throw new NotFoundError('learning item', 'ITEM_NOT_FOUND');
    return toLearningItemDto(item, await this.dtoContext());
  }

  async create(actor: Actor, input: LearningItemInput): Promise<LearningItemDto> {
    this.assertCanManage(actor);
    const cycle = await this.cycleOrCurrent(input.cycleId);
    const fields = await this.validatedFields(input);
    return this.uow.run(async () => {
      const created = await this.items.create({ ...fields, cycleId: cycle.id, createdBy: actor.id });
      await this.audit.record({ actorId: actor.id, action: 'item.created', entityType: 'learning_item', entityId: created.id, metadata: { title: created.title } });
      return toLearningItemDto(created, await this.dtoContext());
    });
  }

  async update(actor: Actor, id: string, input: LearningItemInput): Promise<LearningItemDto> {
    this.assertCanManage(actor);
    const existing = await this.items.findById(id);
    if (!existing) throw new NotFoundError('learning item', 'ITEM_NOT_FOUND');
    if (existing.archivedAt) throw new BusinessRuleError('Archived items cannot be edited.', 'ITEM_ARCHIVED');
    const fields = await this.validatedFields(input);
    return this.uow.run(async () => {
      const updated = await this.items.update(id, fields);
      await this.audit.record({ actorId: actor.id, action: 'item.updated', entityType: 'learning_item', entityId: id, metadata: { title: updated.title } });
      return toLearningItemDto(updated, await this.dtoContext());
    });
  }

  /** Soft delete (decision D6): the item leaves everyone's plan; completions are kept. */
  async archive(actor: Actor, id: string): Promise<void> {
    this.assertCanManage(actor);
    const existing = await this.items.findById(id);
    if (!existing) throw new NotFoundError('learning item', 'ITEM_NOT_FOUND');
    if (existing.archivedAt) return;
    await this.uow.run(async () => {
      await this.items.archive(id);
      await this.audit.record({ actorId: actor.id, action: 'item.archived', entityType: 'learning_item', entityId: id, metadata: { title: existing.title } });
    });
  }

  /** TemplateCopier: copies non-archived items into a new cycle, shifting due dates by whole years. */
  async copyTemplate(fromCycleId: string, toCycleId: string, yearShift: number, actorId: string): Promise<number> {
    const source = await this.items.listByCycle(fromCycleId);
    const copies: NewLearningItem[] = source.map((i) => ({
      title: i.title,
      categoryId: i.categoryId,
      cpdTypeId: i.cpdTypeId,
      deliveryTypeId: i.deliveryTypeId,
      provider: i.provider,
      hours: i.hours,
      dueDate: i.dueDate ? addYears(i.dueDate, yearShift) : null,
      isMandatory: i.isMandatory,
      evidenceMode: i.evidenceMode,
      link: i.link,
      description: i.description,
      audience: i.audience,
      cycleId: toCycleId,
      createdBy: actorId,
    }));
    return this.items.createMany(copies);
  }

  private async cycleOrCurrent(cycleId?: string) {
    const cycle = cycleId ? await this.cycles.findById(cycleId) : await this.cycles.findCurrent();
    if (!cycle) {
      if (cycleId) throw new NotFoundError('learning year', 'CYCLE_NOT_FOUND');
      throw new BusinessRuleError('No learning year is set as current. Create one first.', 'NO_CURRENT_CYCLE');
    }
    return cycle;
  }

  /** Domain validation of references (lookups exist and are active; named people exist). */
  private async validatedFields(input: LearningItemInput): Promise<LearningItemFields> {
    const lookups = await this.lookups.all();
    const details: ErrorDetail[] = [];
    const activeIds = (list: { id: number; isActive: boolean }[]) => new Set(list.filter((x) => x.isActive).map((x) => x.id));
    if (!activeIds(lookups.categories).has(input.categoryId)) details.push({ path: 'categoryId', message: 'Unknown category' });
    if (!activeIds(lookups.cpdTypes).has(input.cpdTypeId)) details.push({ path: 'cpdTypeId', message: 'Unknown CPD type' });
    if (!activeIds(lookups.deliveryTypes).has(input.deliveryTypeId)) details.push({ path: 'deliveryTypeId', message: 'Unknown training type' });

    const audience = toAudience(input.audience);
    const designationIds = activeIds(lookups.designations);
    if (audience.designationIds.some((id) => !designationIds.has(id))) {
      details.push({ path: 'audience.designationIds', message: 'Unknown designation' });
    }
    if (audience.profileIds.length > 0) {
      const found = await this.people.list({ ids: audience.profileIds });
      if (found.length !== audience.profileIds.length) details.push({ path: 'audience.profileIds', message: 'Unknown person' });
    }
    if (details.length > 0) throw new ValidationError(details[0]!.message + '.', details);

    return {
      title: input.title.trim(),
      categoryId: input.categoryId,
      cpdTypeId: input.cpdTypeId,
      deliveryTypeId: input.deliveryTypeId,
      provider: input.provider?.trim() || 'Internal',
      hours: Math.round(input.hours * 100) / 100,
      dueDate: input.dueDate ?? null,
      isMandatory: input.isMandatory,
      evidenceMode: input.evidenceMode,
      link: input.link?.trim() || null,
      description: input.description?.trim() || null,
      audience,
    };
  }

  private async dtoContext(): Promise<{ lookups: Lookups; peopleById: Map<string, { id: string; fullName: string }> }> {
    const [lookups, people] = await Promise.all([this.lookups.all(), this.people.list()]);
    return { lookups, peopleById: new Map(people.map((p) => [p.id, p])) };
  }

  private assertCanManage(actor: Actor): void {
    if (!can(actor, 'manageItems')) throw new ForbiddenError('Only the Learning Team can change the learning template.');
  }
}
