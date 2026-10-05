import type { LearningItem, LearningItemFields, NewLearningItem } from '../../domain/entities/learning-item.js';
import type { LearningItemRepository } from '../../domain/repositories/learning-item-repository.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/app-errors.js';
import type { SqlExecutor } from '../database/database.js';
import { isForeignKeyViolation } from '../database/pg-errors.js';

interface ItemRow {
  id: string;
  cycle_id: string;
  title: string;
  category_id: number;
  cpd_type_id: number;
  delivery_type_id: number;
  provider: string;
  hours: number;
  due_date: string | null;
  is_mandatory: boolean;
  evidence_mode: LearningItem['evidenceMode'];
  link: string | null;
  description: string | null;
  assign_to_all: boolean;
  created_by: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  designation_ids: number[] | null;
  profile_ids: string[] | null;
}

// Audience is aggregated in the same query to avoid N+1 lookups.
const SELECT = `
  select i.*,
    coalesce((select array_agg(d.designation_id order by d.designation_id) from learning_item_designations d where d.item_id = i.id), '{}') as designation_ids,
    coalesce((select array_agg(p.profile_id) from learning_item_profiles p where p.item_id = i.id), '{}') as profile_ids
  from learning_items i`;

const FIELD_COLUMNS: Record<Exclude<keyof LearningItemFields, 'audience'>, string> = {
  title: 'title',
  categoryId: 'category_id',
  cpdTypeId: 'cpd_type_id',
  deliveryTypeId: 'delivery_type_id',
  provider: 'provider',
  hours: 'hours',
  dueDate: 'due_date',
  isMandatory: 'is_mandatory',
  evidenceMode: 'evidence_mode',
  link: 'link',
  description: 'description',
};

function toItem(r: ItemRow): LearningItem {
  return {
    id: r.id,
    cycleId: r.cycle_id,
    title: r.title,
    categoryId: r.category_id,
    cpdTypeId: r.cpd_type_id,
    deliveryTypeId: r.delivery_type_id,
    provider: r.provider,
    hours: Number(r.hours),
    dueDate: r.due_date,
    isMandatory: r.is_mandatory,
    evidenceMode: r.evidence_mode,
    link: r.link,
    description: r.description,
    audience: r.assign_to_all
      ? { all: true, designationIds: [], profileIds: [] }
      : { all: false, designationIds: r.designation_ids ?? [], profileIds: r.profile_ids ?? [] },
    createdBy: r.created_by,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function translate(err: unknown): never {
  if (isForeignKeyViolation(err)) {
    throw new BusinessRuleError('A selected category, type, designation or person no longer exists.', 'INVALID_REFERENCE');
  }
  throw err;
}

export class PgLearningItemRepository implements LearningItemRepository {
  constructor(private readonly db: SqlExecutor) {}

  async listByCycle(cycleId: string, options: { includeArchived?: boolean } = {}): Promise<LearningItem[]> {
    const res = await this.db.query<ItemRow>(
      `${SELECT} where i.cycle_id = $1 ${options.includeArchived ? '' : 'and i.archived_at is null'}
       order by i.due_date nulls last, i.title`,
      [cycleId],
    );
    return res.rows.map(toItem);
  }

  async findById(id: string): Promise<LearningItem | null> {
    const res = await this.db.query<ItemRow>(`${SELECT} where i.id = $1`, [id]);
    return res.rows[0] ? toItem(res.rows[0]) : null;
  }

  async create(item: NewLearningItem): Promise<LearningItem> {
    try {
      const res = await this.db.query<{ id: string }>(
        `insert into learning_items (cycle_id, title, category_id, cpd_type_id, delivery_type_id, provider, hours, due_date,
           is_mandatory, evidence_mode, link, description, assign_to_all, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [
          item.cycleId,
          item.title,
          item.categoryId,
          item.cpdTypeId,
          item.deliveryTypeId,
          item.provider,
          item.hours,
          item.dueDate,
          item.isMandatory,
          item.evidenceMode,
          item.link,
          item.description,
          item.audience.all,
          item.createdBy,
        ],
      );
      const id = res.rows[0]!.id;
      await this.replaceAudience(id, item.audience);
      return (await this.findById(id))!;
    } catch (err) {
      translate(err);
    }
  }

  async createMany(items: NewLearningItem[]): Promise<number> {
    for (const item of items) await this.create(item);
    return items.length;
  }

  async update(id: string, fields: Partial<LearningItemFields>): Promise<LearningItem> {
    const { audience, ...columns } = fields;
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined) as [keyof typeof FIELD_COLUMNS, unknown][];
    try {
      if (entries.length > 0 || audience) {
        const sets = entries.map(([k], i) => `${FIELD_COLUMNS[k]} = $${i + 2}`);
        if (audience) sets.push(`assign_to_all = $${entries.length + 2}`);
        const params = [id, ...entries.map(([, v]) => v), ...(audience ? [audience.all] : [])];
        const res = await this.db.query(`update learning_items set ${sets.join(', ')} where id = $1`, params);
        if (res.rowCount === 0) throw new NotFoundError('learning item', 'ITEM_NOT_FOUND');
        if (audience) await this.replaceAudience(id, audience);
      }
    } catch (err) {
      translate(err);
    }
    const updated = await this.findById(id);
    if (!updated) throw new NotFoundError('learning item', 'ITEM_NOT_FOUND');
    return updated;
  }

  async archive(id: string): Promise<void> {
    const res = await this.db.query('update learning_items set archived_at = now() where id = $1 and archived_at is null', [id]);
    if (res.rowCount === 0) throw new NotFoundError('learning item', 'ITEM_NOT_FOUND');
  }

  private async replaceAudience(itemId: string, audience: LearningItem['audience']): Promise<void> {
    await this.db.query('delete from learning_item_designations where item_id = $1', [itemId]);
    await this.db.query('delete from learning_item_profiles where item_id = $1', [itemId]);
    if (audience.all) return;
    if (audience.designationIds.length > 0) {
      await this.db.query(
        'insert into learning_item_designations (item_id, designation_id) select $1, unnest($2::smallint[])',
        [itemId, audience.designationIds],
      );
    }
    if (audience.profileIds.length > 0) {
      await this.db.query('insert into learning_item_profiles (item_id, profile_id) select $1, unnest($2::uuid[])', [
        itemId,
        audience.profileIds,
      ]);
    }
  }
}
