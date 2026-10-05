import type { Person, PersonChanges } from '../../domain/entities/person.js';
import { avatarColorFor } from '../../domain/entities/person.js';
import type { ProfileStatus, ReportingAccess, UserRole } from '../../domain/enums.js';
import type { AuditLog } from '../../domain/repositories/audit-log.js';
import type { LookupRepository } from '../../domain/repositories/lookup-repository.js';
import type { PersonFilter, PersonRepository } from '../../domain/repositories/person-repository.js';
import { can, type Actor } from '../../domain/services/access-policy.js';
import { defaultReportingAccess } from '../../domain/services/reporting-access.js';
import { toEmail } from '../../domain/value-objects/email.js';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors/app-errors.js';
import { toPersonDto, type PersonDto } from '../dto/person.dto.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

export interface PersonInput {
  fullName: string;
  email: string;
  role: UserRole;
  designationId: number | null;
  /** Omit to apply the default for the role/designation. */
  reportingAccess?: ReportingAccess;
  lineManagerId: string | null;
  status?: ProfileStatus;
}

export type PersonUpdate = Partial<PersonInput>;

export interface PersonAdminDto extends PersonDto {
  lastSeenAt: string | null;
  reportCount: number;
}

/** User Management (Learning Team only). */
export class PeopleService {
  constructor(
    private readonly people: PersonRepository,
    private readonly lookups: LookupRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async list(actor: Actor, filter: Omit<PersonFilter, 'ids'> = {}): Promise<PersonAdminDto[]> {
    this.assertCanManage(actor);
    const [list, everyone, ctx] = await Promise.all([this.people.list(filter), this.people.list(), this.context()]);
    const reports = new Map<string, number>();
    for (const p of everyone) if (p.lineManagerId) reports.set(p.lineManagerId, (reports.get(p.lineManagerId) ?? 0) + 1);
    return list.map((p) => ({
      ...toPersonDto(p, ctx),
      lastSeenAt: p.lastSeenAt?.toISOString() ?? null,
      reportCount: reports.get(p.id) ?? 0,
    }));
  }

  async create(actor: Actor, input: PersonInput): Promise<PersonAdminDto> {
    this.assertCanManage(actor);
    return this.uow.run(async () => {
      const email = toEmail(input.email);
      await this.assertValidManager(null, input.lineManagerId);
      const reportingAccess = input.reportingAccess ?? (await this.defaultAccess(input.role, input.designationId));
      const created = await this.people.create({
        fullName: requireName(input.fullName),
        email,
        role: input.role,
        designationId: await this.validDesignation(input.designationId),
        reportingAccess,
        lineManagerId: input.lineManagerId,
        status: input.status ?? 'active',
        avatarColor: avatarColorFor(await this.people.count()),
      });
      await this.audit.record({ actorId: actor.id, action: 'user.created', entityType: 'profile', entityId: created.id, metadata: { email, role: input.role } });
      return this.toAdminDto(created);
    });
  }

  async update(actor: Actor, id: string, input: PersonUpdate): Promise<PersonAdminDto> {
    this.assertCanManage(actor);
    return this.uow.run(async () => this.toAdminDto(await this.applyUpdate(actor, id, input)));
  }

  /** The inline-edit "Save settings" on User Management: all changes succeed or none do. */
  async bulkUpdate(actor: Actor, updates: (PersonUpdate & { id: string })[]): Promise<PersonAdminDto[]> {
    this.assertCanManage(actor);
    if (updates.length === 0) return [];
    const ids = new Set<string>();
    for (const u of updates) {
      if (ids.has(u.id)) throw new ValidationError('Each person can appear only once.', [{ path: 'updates', message: `Duplicate id ${u.id}` }]);
      ids.add(u.id);
    }
    return this.uow.run(async () => {
      const saved: Person[] = [];
      for (const { id, ...changes } of updates) saved.push(await this.applyUpdate(actor, id, changes));
      return Promise.all(saved.map((p) => this.toAdminDto(p)));
    });
  }

  private async applyUpdate(actor: Actor, id: string, input: PersonUpdate): Promise<Person> {
    const current = await this.people.findById(id);
    if (!current) throw new NotFoundError('person');

    // Guard against admins locking themselves out.
    if (id === actor.id) {
      if (input.role !== undefined && input.role !== 'learning_team') {
        throw new BusinessRuleError('You cannot remove your own Learning Team role.', 'SELF_DEMOTION');
      }
      if (input.status !== undefined && input.status !== 'active') {
        throw new BusinessRuleError('You cannot deactivate your own account.', 'SELF_DEACTIVATION');
      }
    }

    const changes: PersonChanges = {};
    if (input.fullName !== undefined) changes.fullName = requireName(input.fullName);
    if (input.email !== undefined) changes.email = toEmail(input.email);
    if (input.role !== undefined) changes.role = input.role;
    if (input.designationId !== undefined) changes.designationId = await this.validDesignation(input.designationId);
    if (input.status !== undefined) changes.status = input.status;
    if (input.lineManagerId !== undefined) {
      await this.assertValidManager(id, input.lineManagerId);
      changes.lineManagerId = input.lineManagerId;
    }

    // Business rule 4: role/designation changes reset access to the default unless set explicitly.
    if (input.reportingAccess !== undefined) {
      changes.reportingAccess = input.reportingAccess;
    } else if (changes.role !== undefined || changes.designationId !== undefined) {
      changes.reportingAccess = await this.defaultAccess(changes.role ?? current.role, changes.designationId !== undefined ? changes.designationId : current.designationId);
    }

    const updated = await this.people.update(id, changes);
    await this.audit.record({ actorId: actor.id, action: 'user.updated', entityType: 'profile', entityId: id, metadata: { ...changes } });
    return updated;
  }

  /** A line manager must exist, not be the person, and must not create a reporting loop. */
  private async assertValidManager(personId: string | null, managerId: string | null): Promise<void> {
    if (!managerId) return;
    if (managerId === personId) throw new BusinessRuleError('A person cannot be their own line manager.', 'INVALID_LINE_MANAGER');
    const manager = await this.people.findById(managerId);
    if (!manager) throw new ValidationError('The selected line manager does not exist.', [{ path: 'lineManagerId', message: 'Unknown person' }]);
    if (!personId) return;
    let cursor: Person | null = manager;
    for (let depth = 0; cursor && depth < 50; depth++) {
      if (cursor.lineManagerId === personId) {
        throw new BusinessRuleError('That would create a reporting loop.', 'REPORTING_LOOP');
      }
      cursor = cursor.lineManagerId ? await this.people.findById(cursor.lineManagerId) : null;
    }
  }

  private async validDesignation(id: number | null): Promise<number | null> {
    if (id === null) return null;
    const d = await this.lookups.findDesignation(id);
    if (!d || !d.isActive) throw new ValidationError('Unknown designation.', [{ path: 'designationId', message: 'Unknown designation' }]);
    return id;
  }

  private async defaultAccess(role: UserRole, designationId: number | null): Promise<ReportingAccess> {
    const d = designationId !== null ? await this.lookups.findDesignation(designationId) : null;
    return defaultReportingAccess(role, d?.grantsFullAccess ?? false);
  }

  private async context() {
    const [lookups, everyone] = await Promise.all([this.lookups.all(), this.people.list()]);
    return { designations: new Map(lookups.designations.map((d) => [d.id, d])), peopleById: new Map(everyone.map((p) => [p.id, p])) };
  }

  private async toAdminDto(p: Person): Promise<PersonAdminDto> {
    const ctx = await this.context();
    const reportCount = [...ctx.peopleById.values()].filter((x) => x.lineManagerId === p.id).length;
    return { ...toPersonDto(p, ctx), lastSeenAt: p.lastSeenAt?.toISOString() ?? null, reportCount };
  }

  private assertCanManage(actor: Actor): void {
    if (!can(actor, 'manageUsers')) throw new ForbiddenError('Only the Learning Team can manage users.');
  }
}

function requireName(name: string): string {
  const v = name.trim();
  if (!v) throw new ValidationError('Enter a full name.', [{ path: 'fullName', message: 'Required' }]);
  return v;
}
