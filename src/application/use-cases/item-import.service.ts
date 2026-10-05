import type { NewLearningItem } from '../../domain/entities/learning-item.js';
import type { Lookups } from '../../domain/entities/lookups.js';
import type { Person } from '../../domain/entities/person.js';
import type { AuditLog } from '../../domain/repositories/audit-log.js';
import type { CycleRepository } from '../../domain/repositories/cycle-repository.js';
import type { LearningItemRepository } from '../../domain/repositories/learning-item-repository.js';
import type { LookupRepository } from '../../domain/repositories/lookup-repository.js';
import type { PersonRepository } from '../../domain/repositories/person-repository.js';
import { can, type Actor } from '../../domain/services/access-policy.js';
import type { Audience } from '../../domain/value-objects/audience.js';
import { LIMITS } from '../../shared/constants/limits.js';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-errors.js';
import type { WorkbookReader, WorkbookWriter } from '../ports/workbook.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { byName, isHttpUrl, parseDate, parseHours, parseYesNo } from '../services/import-parsing.js';

export interface ImportRowResult {
  rowNumber: number;
  values: Record<string, string>;
  errors: string[];
  /** Human summary for the review step. */
  summary: {
    title: string;
    hours: number | null;
    dueDate: string | null;
    deliveryType: string;
    provider: string;
    assignTo: string;
  } | null;
}

export interface ImportPreview {
  rows: ImportRowResult[];
  validCount: number;
  errorCount: number;
}

const COLUMNS = [
  'name',
  'category',
  'cpd_type',
  'type',
  'provider',
  'hours',
  'due_date',
  'mandatory',
  'evidence',
  'link',
  'description',
  'assign_to',
];

/** Bulk import of Learning Items from Excel/CSV (preview → confirm). */
export class ItemImportService {
  constructor(
    private readonly items: LearningItemRepository,
    private readonly cycles: CycleRepository,
    private readonly lookups: LookupRepository,
    private readonly people: PersonRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly reader: WorkbookReader,
    private readonly writer: WorkbookWriter,
  ) {}

  async template(actor: Actor): Promise<{ fileName: string; content: Buffer }> {
    this.assertCanManage(actor);
    const l = await this.lookups.all();
    const content = await this.writer.write(
      [
        {
          name: 'Learning Items',
          headerRow: 0,
          columnWidths: [38, 24, 22, 20, 16, 9, 13, 12, 16, 30, 40, 40],
          rows: [
            COLUMNS,
            [
              'Anti-Money Laundering Refresh',
              'Mandatory Compliance',
              'Mandatory Compliance',
              'eLearning',
              'ICAEW',
              1.5,
              '2026-03-31',
              'yes',
              'certificate',
              'https://www.icaew.com',
              'Annual AML refresher',
              'all',
            ],
            [
              'IFRS 16 Leases Update',
              'Structured CPD',
              'Structured CPD',
              'Webinar',
              'ICAEW',
              3,
              '2026-09-30',
              'no',
              'certificate',
              '',
              'Lessee accounting update',
              'Senior Accountant; Manager',
            ],
            [
              'Audit Quality Standards',
              'Structured CPD',
              'Structured CPD',
              'Online Course',
              'ACCA',
              5,
              '2026-11-30',
              'no',
              'certificate',
              '',
              'ISQM 1 in practice',
              'imoolla@projectaccountants.co.uk',
            ],
          ],
        },
        {
          name: 'Guidance',
          headerRow: 0,
          columnWidths: [16, 12, 90],
          rows: [
            ['Column', 'Required', 'Accepted values'],
            ['name', 'Yes', 'The activity title'],
            ['hours', 'Yes', 'Decimal hours, e.g. 1.5'],
            ['category', 'No', l.categories.map((c) => c.name).join(' / ') + ' (default Structured CPD)'],
            ['cpd_type', 'No', l.cpdTypes.map((c) => c.name).join(' / ') + ' (default Structured CPD)'],
            ['type', 'No', l.deliveryTypes.map((c) => c.name).join(' / ') + ' (default eLearning)'],
            ['provider', 'No', 'Free text, e.g. ICAEW (default Internal)'],
            ['due_date', 'No', 'YYYY-MM-DD or DD/MM/YYYY'],
            ['mandatory', 'No', 'yes / no (default no)'],
            [
              'evidence',
              'No',
              'certificate (upload required) / acknowledgement (confirm only). Default certificate',
            ],
            ['link', 'No', 'Full https:// URL'],
            ['description', 'No', 'Free text'],
            [
              'assign_to',
              'No',
              'all (or blank) / designation names / work emails - separate several with ";"',
            ],
          ],
        },
        {
          name: 'Designations',
          headerRow: 0,
          columnWidths: [26],
          rows: [['Designation'], ...l.designations.map((d) => [d.name])],
        },
      ],
      { title: 'Learning template import' },
    );
    return { fileName: 'learning-items-import-template.xlsx', content };
  }

  async preview(actor: Actor, bytes: Uint8Array, fileName: string): Promise<ImportPreview> {
    this.assertCanManage(actor);
    const rows = await this.reader.readRows(bytes, fileName);
    if (rows.length > LIMITS.importMaxRows) {
      throw new ValidationError(
        `Import at most ${LIMITS.importMaxRows} rows at a time.`,
        undefined,
        'TOO_MANY_ROWS',
      );
    }
    return this.validate(rows);
  }

  async commit(
    actor: Actor,
    cycleId: string | undefined,
    rows: { rowNumber: number; values: Record<string, string> }[],
  ) {
    this.assertCanManage(actor);
    if (rows.length === 0)
      throw new ValidationError('There are no rows to import.', undefined, 'EMPTY_IMPORT');
    if (rows.length > LIMITS.importMaxRows)
      throw new ValidationError(
        `Import at most ${LIMITS.importMaxRows} rows at a time.`,
        undefined,
        'TOO_MANY_ROWS',
      );
    const cycle = cycleId ? await this.cycles.findById(cycleId) : await this.cycles.findCurrent();
    if (!cycle) {
      if (cycleId) throw new NotFoundError('learning year', 'CYCLE_NOT_FOUND');
      throw new BusinessRuleError(
        'No learning year is set as current. Create one first.',
        'NO_CURRENT_CYCLE',
      );
    }

    // Never trust the client's preview: validate again and reject the whole batch on any error.
    const { lookups, peopleByEmail } = await this.context();
    const parsed = rows.map((r) => ({ r, ...parseRow(r.values, lookups, peopleByEmail) }));
    const bad = parsed.filter((p) => p.errors.length > 0);
    if (bad.length > 0) {
      throw new ValidationError(
        `${bad.length} row(s) have problems. Fix them and upload again.`,
        bad.slice(0, 50).map((b) => ({ path: `row ${b.r.rowNumber}`, message: b.errors.join('; ') })),
        'IMPORT_INVALID',
      );
    }

    return this.uow.run(async () => {
      const created = await this.items.createMany(
        parsed.map((p) => ({ ...p.item!, cycleId: cycle.id, createdBy: actor.id })),
      );
      await this.audit.record({
        actorId: actor.id,
        action: 'item.imported',
        entityType: 'learning_cycle',
        entityId: cycle.id,
        metadata: { count: created },
      });
      return { created, cycleId: cycle.id };
    });
  }

  private async validate(
    rows: { rowNumber: number; values: Record<string, string> }[],
  ): Promise<ImportPreview> {
    const { lookups, peopleByEmail } = await this.context();
    const results: ImportRowResult[] = rows.map((r) => {
      const { item, errors, assignTo } = parseRow(r.values, lookups, peopleByEmail);
      return {
        rowNumber: r.rowNumber,
        values: r.values,
        errors,
        summary: item
          ? {
              title: item.title,
              hours: item.hours,
              dueDate: item.dueDate,
              deliveryType: lookups.deliveryTypes.find((d) => d.id === item.deliveryTypeId)?.name ?? '',
              provider: item.provider,
              assignTo,
            }
          : null,
      };
    });
    const errorCount = results.filter((r) => r.errors.length > 0).length;
    return { rows: results, validCount: results.length - errorCount, errorCount };
  }

  private async context() {
    const [lookups, people] = await Promise.all([this.lookups.all(), this.people.list()]);
    return { lookups, peopleByEmail: new Map(people.map((p) => [p.email.toLowerCase(), p])) };
  }

  private assertCanManage(actor: Actor): void {
    if (!can(actor, 'manageItems'))
      throw new ForbiddenError('Only the Learning Team can import learning items.');
  }
}

type ParsedItem = Omit<NewLearningItem, 'cycleId' | 'createdBy'>;

/** Validates one spreadsheet row (business rule 8). Pure function. */
export function parseRow(
  v: Record<string, string>,
  lookups: Lookups,
  peopleByEmail: Map<string, Person>,
): { item: ParsedItem | null; errors: string[]; assignTo: string } {
  const errors: string[] = [];
  const active = <T extends { isActive: boolean }>(list: T[]) => list.filter((x) => x.isActive);

  const title = (v.name ?? '').trim();
  if (!title) errors.push('name is required');
  else if (title.length > LIMITS.titleMax) errors.push(`name is longer than ${LIMITS.titleMax} characters`);

  const hours = parseHours(v.hours, LIMITS.hoursMax);
  if (hours === undefined) errors.push(`hours must be a number between 0 and ${LIMITS.hoursMax}`);

  const pick = (
    list: { id: number; name: string; isActive: boolean }[],
    raw: string | undefined,
    def: string,
    label: string,
  ) => {
    const found = byName(active(list), raw || def);
    if (!found) errors.push(`${label} "${raw}" is not recognised`);
    return found?.id;
  };
  const categoryId = pick(lookups.categories, v.category, 'Structured CPD', 'category');
  const cpdTypeId = pick(lookups.cpdTypes, v.cpd_type, 'Structured CPD', 'cpd_type');
  const deliveryTypeId = pick(lookups.deliveryTypes, v.type, 'eLearning', 'type');

  const dueDate = parseDate(v.due_date);
  if (dueDate === undefined) errors.push('due_date must be YYYY-MM-DD or DD/MM/YYYY');

  const isMandatory = parseYesNo(v.mandatory, false);
  if (isMandatory === undefined) errors.push('mandatory must be yes or no');

  const evidenceRaw = (v.evidence ?? '').trim().toLowerCase();
  const evidenceMode =
    !evidenceRaw || evidenceRaw.startsWith('cert')
      ? 'certificate'
      : evidenceRaw.startsWith('ack')
        ? 'acknowledgement'
        : null;
  if (!evidenceMode) errors.push('evidence must be certificate or acknowledgement');

  const link = (v.link ?? '').trim() || null;
  if (link && !isHttpUrl(link)) errors.push('link must start with http:// or https://');

  const description = (v.description ?? '').trim() || null;
  if (description && description.length > LIMITS.descriptionMax) errors.push('description is too long');

  const provider = (v.provider ?? '').trim() || 'Internal';
  if (provider.length > LIMITS.providerMax) errors.push('provider is too long');

  // assign_to: all | designation names | emails, separated by ';'
  const assignRaw = (v.assign_to ?? '').trim();
  let audience: Audience = { all: true, designationIds: [], profileIds: [] };
  if (assignRaw && assignRaw.toLowerCase() !== 'all') {
    const designationIds: number[] = [];
    const profileIds: string[] = [];
    for (const token of assignRaw
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean)) {
      if (token.includes('@')) {
        const person = peopleByEmail.get(token.toLowerCase());
        if (person) profileIds.push(person.id);
        else errors.push(`assign_to: no one with email ${token}`);
      } else {
        const d = byName(active(lookups.designations), token);
        if (d) designationIds.push(d.id);
        else errors.push(`assign_to: "${token}" is not a designation`);
      }
    }
    audience = {
      all: false,
      designationIds: [...new Set(designationIds)],
      profileIds: [...new Set(profileIds)],
    };
  }

  if (errors.length > 0) return { item: null, errors, assignTo: assignRaw || 'all' };
  return {
    item: {
      title,
      hours: hours!,
      categoryId: categoryId!,
      cpdTypeId: cpdTypeId!,
      deliveryTypeId: deliveryTypeId!,
      provider,
      dueDate: dueDate ?? null,
      isMandatory: isMandatory!,
      evidenceMode: evidenceMode!,
      link,
      description,
      audience,
    },
    errors,
    assignTo: assignRaw || 'all',
  };
}
