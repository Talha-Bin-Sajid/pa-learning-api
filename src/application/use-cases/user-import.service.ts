import { avatarColorFor } from '../../domain/entities/person.js';
import type { Designation } from '../../domain/entities/lookups.js';
import type { ReportingAccess, UserRole } from '../../domain/enums.js';
import type { AuditLog } from '../../domain/repositories/audit-log.js';
import type { LookupRepository } from '../../domain/repositories/lookup-repository.js';
import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import { can, type Actor } from '../../domain/services/access-policy.js';
import { defaultReportingAccess } from '../../domain/services/reporting-access.js';
import { LIMITS } from '../../shared/constants/limits.js';
import { ROLE_LABELS } from '../../shared/constants/labels.js';
import { ForbiddenError, ValidationError } from '../../shared/errors/app-errors.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { WorkbookReader, WorkbookWriter } from '../ports/workbook.js';
import { byName } from '../services/import-parsing.js';

interface ParsedUser {
  fullName: string;
  email: string;
  role: UserRole;
  designation: Designation | null;
  /** null → default for role/designation. */
  access: ReportingAccess | null;
  lineManagerEmail: string | null;
}

export interface UserImportRow {
  rowNumber: number;
  values: Record<string, string>;
  errors: string[];
  action: 'create' | 'update' | null;
  summary: {
    fullName: string;
    email: string;
    role: string;
    designation: string | null;
    lineManagerEmail: string | null;
  } | null;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function roleFromLabel(raw: string | undefined): UserRole | undefined {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t || t.startsWith('team')) return 'team_member';
  if (t.startsWith('learning')) return 'learning_team';
  if (t.startsWith('hr') || t.includes('human')) return 'hr';
  if (t.startsWith('manager')) return 'manager';
  return undefined;
}

/** Bulk create/update of people from Excel/CSV, matched on email (business rule 9). */
export class UserImportService {
  constructor(
    private readonly people: PersonRepository,
    private readonly lookups: LookupRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly reader: WorkbookReader,
    private readonly writer: WorkbookWriter,
  ) {}

  async template(actor: Actor): Promise<{ fileName: string; content: Buffer }> {
    this.assertCanManage(actor);
    const l = await this.lookups.all();
    const content = await this.writer.write([
      {
        name: 'Users',
        headerRow: 0,
        columnWidths: [26, 40, 18, 22, 10, 40],
        rows: [
          ['name', 'email', 'role', 'designation', 'access', 'line_manager_email'],
          ['Amina Patel', 'apatel@projectaccountants.co.uk', 'Learning Team', 'Senior Manager', 'full', ''],
          ['Daniel Okoro', 'dokoro@projectaccountants.co.uk', 'Manager', 'Director', '', ''],
          [
            'Grace Lin',
            'glin@projectaccountants.co.uk',
            'Team Member',
            'Junior Accountant',
            '',
            'dokoro@projectaccountants.co.uk',
          ],
        ],
      },
      {
        name: 'Guidance',
        headerRow: 0,
        columnWidths: [20, 12, 90],
        rows: [
          ['Column', 'Required', 'Accepted values'],
          ['name', 'Yes', 'Full name'],
          [
            'email',
            'Yes',
            'Work email - the sign-in address reminders go to. Existing people are matched on email and updated.',
          ],
          ['role', 'No', Object.values(ROLE_LABELS).join(' / ') + ' (default Team Member)'],
          ['designation', 'No', l.designations.map((d) => d.name).join(' / ')],
          [
            'access',
            'No',
            'full (all-staff reporting) / self (own reports). Blank follows the role and designation rules.',
          ],
          [
            'line_manager_email',
            'No',
            'Email of the person they report to (can be another row in this file)',
          ],
        ],
      },
      {
        name: 'Designations',
        headerRow: 0,
        columnWidths: [26],
        rows: [['Designation'], ...l.designations.map((d) => [d.name])],
      },
    ]);
    return { fileName: 'users-import-template.xlsx', content };
  }

  async preview(actor: Actor, bytes: Uint8Array, fileName: string) {
    this.assertCanManage(actor);
    const rows = await this.reader.readRows(bytes, fileName);
    if (rows.length > LIMITS.importMaxRows)
      throw new ValidationError(
        `Import at most ${LIMITS.importMaxRows} rows at a time.`,
        undefined,
        'TOO_MANY_ROWS',
      );
    const results = await this.validate(rows);
    const errorCount = results.filter((r) => r.errors.length > 0).length;
    return { rows: results, validCount: results.length - errorCount, errorCount };
  }

  async commit(actor: Actor, rows: { rowNumber: number; values: Record<string, string> }[]) {
    this.assertCanManage(actor);
    if (rows.length === 0)
      throw new ValidationError('There are no rows to import.', undefined, 'EMPTY_IMPORT');
    if (rows.length > LIMITS.importMaxRows)
      throw new ValidationError(
        `Import at most ${LIMITS.importMaxRows} rows at a time.`,
        undefined,
        'TOO_MANY_ROWS',
      );
    const results = await this.validate(rows);
    const bad = results.filter((r) => r.errors.length > 0);
    if (bad.length > 0) {
      throw new ValidationError(
        `${bad.length} row(s) have problems. Fix them and upload again.`,
        bad.slice(0, 50).map((b) => ({ path: `row ${b.rowNumber}`, message: b.errors.join('; ') })),
        'IMPORT_INVALID',
      );
    }
    return this.uow.run(async () => {
      const designations = (await this.lookups.all()).designations;
      const users = rows.map((r) => parseUserRow(r.values, designations).user!);
      let added = 0;
      let updated = 0;
      let seed = await this.people.count();
      const idByEmail = new Map<string, string>();

      // Pass 1: create / update people (managers resolved in pass 2 so rows can reference each other).
      for (const u of users) {
        const access = u.access ?? defaultReportingAccess(u.role, u.designation?.grantsFullAccess ?? false);
        const existing = await this.people.findByEmail(u.email);
        if (existing) {
          if (existing.id === actor.id && u.role !== 'learning_team') {
            throw new ValidationError(
              'You cannot remove your own Learning Team role.',
              [{ path: u.email, message: 'Self demotion' }],
              'SELF_DEMOTION',
            );
          }
          await this.people.update(existing.id, {
            fullName: u.fullName,
            role: u.role,
            designationId: u.designation?.id ?? null,
            reportingAccess: access,
          });
          idByEmail.set(u.email, existing.id);
          updated++;
        } else {
          const created = await this.people.create({
            fullName: u.fullName,
            email: u.email,
            role: u.role,
            designationId: u.designation?.id ?? null,
            reportingAccess: access,
            lineManagerId: null,
            status: 'active',
            avatarColor: avatarColorFor(seed++),
          });
          idByEmail.set(u.email, created.id);
          added++;
        }
      }

      // Pass 2: line managers.
      for (const u of users) {
        if (!u.lineManagerEmail) continue;
        const managerId =
          idByEmail.get(u.lineManagerEmail) ?? (await this.people.findByEmail(u.lineManagerEmail))?.id;
        const personId = idByEmail.get(u.email)!;
        if (!managerId || managerId === personId) continue; // validated already; defensive
        await this.people.update(personId, { lineManagerId: managerId });
      }

      await this.audit.record({
        actorId: actor.id,
        action: 'user.imported',
        entityType: 'profile',
        metadata: { added, updated },
      });
      return { added, updated };
    });
  }

  private async validate(
    rows: { rowNumber: number; values: Record<string, string> }[],
  ): Promise<UserImportRow[]> {
    const [lookups, everyone] = await Promise.all([this.lookups.all(), this.people.list()]);
    const known = new Set(everyone.map((p) => p.email.toLowerCase()));
    const inFile = new Set(rows.map((r) => (r.values.email ?? '').trim().toLowerCase()).filter(Boolean));
    const seen = new Set<string>();

    // Resulting reporting lines (file overrides existing) - used to detect loops.
    const emailById = new Map(everyone.map((p) => [p.id, p.email.toLowerCase()]));
    const managerOf = new Map<string, string | null>(
      everyone.map((p) => [
        p.email.toLowerCase(),
        p.lineManagerId ? (emailById.get(p.lineManagerId) ?? null) : null,
      ]),
    );
    for (const r of rows) {
      const e = (r.values.email ?? '').trim().toLowerCase();
      const m = (r.values.line_manager_email ?? '').trim().toLowerCase();
      if (e && m) managerOf.set(e, m);
    }
    const createsLoop = (email: string): boolean => {
      let cursor = managerOf.get(email) ?? null;
      for (let depth = 0; cursor && depth < 100; depth++) {
        if (cursor === email) return true;
        cursor = managerOf.get(cursor) ?? null;
      }
      return false;
    };

    return rows.map((r) => {
      const { user, errors } = parseUserRow(r.values, lookups.designations);
      if (user) {
        if (seen.has(user.email)) errors.push('email appears more than once in this file');
        seen.add(user.email);
        if (user.lineManagerEmail) {
          if (user.lineManagerEmail === user.email) errors.push('a person cannot be their own line manager');
          else if (!known.has(user.lineManagerEmail) && !inFile.has(user.lineManagerEmail)) {
            errors.push(`line_manager_email: no one with email ${user.lineManagerEmail}`);
          } else if (createsLoop(user.email)) {
            errors.push('line_manager_email would create a reporting loop');
          }
        }
      }
      return {
        rowNumber: r.rowNumber,
        values: r.values,
        errors,
        action: user && errors.length === 0 ? (known.has(user.email) ? 'update' : 'create') : null,
        summary: user
          ? {
              fullName: user.fullName,
              email: user.email,
              role: ROLE_LABELS[user.role],
              designation: user.designation?.name ?? null,
              lineManagerEmail: user.lineManagerEmail,
            }
          : null,
      };
    });
  }

  private assertCanManage(actor: Actor): void {
    if (!can(actor, 'manageUsers')) throw new ForbiddenError('Only the Learning Team can import users.');
  }
}

export function parseUserRow(
  v: Record<string, string>,
  designations: Designation[],
): { user: ParsedUser | null; errors: string[] } {
  const errors: string[] = [];
  const fullName = (v.name ?? '').trim();
  if (!fullName) errors.push('name is required');
  else if (fullName.length > LIMITS.nameMax) errors.push('name is too long');

  const email = (v.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) errors.push('email is missing or invalid');

  const role = roleFromLabel(v.role);
  if (!role) errors.push(`role "${v.role}" is not recognised`);

  const designationRaw = (v.designation ?? '').trim();
  const designation = designationRaw
    ? (byName(
        designations.filter((d) => d.isActive),
        designationRaw,
      ) ?? null)
    : null;
  if (designationRaw && !designation) errors.push(`designation "${designationRaw}" is not recognised`);

  const accessRaw = (v.access ?? '').trim().toLowerCase();
  const access: ReportingAccess | null | undefined = !accessRaw
    ? null
    : ['full', 'all'].includes(accessRaw)
      ? 'full'
      : ['self', 'own'].includes(accessRaw)
        ? 'self'
        : undefined;
  if (access === undefined) errors.push('access must be full or self');

  const lineManagerEmail = (v.line_manager_email ?? '').trim().toLowerCase() || null;
  if (lineManagerEmail && !EMAIL.test(lineManagerEmail)) errors.push('line_manager_email is invalid');

  if (errors.length > 0) return { user: null, errors };
  return { user: { fullName, email, role: role!, designation, access: access!, lineManagerEmail }, errors };
}
