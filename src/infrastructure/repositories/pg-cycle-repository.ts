import type { LearningCycle, NewLearningCycle } from '../../domain/entities/learning-cycle.js';
import type { CycleRepository } from '../../domain/repositories/cycle-repository.js';
import { ConflictError, NotFoundError } from '../../shared/errors/app-errors.js';
import type { SqlExecutor } from '../database/database.js';
import { isUniqueViolation } from '../database/pg-errors.js';

interface CycleRow {
  id: string;
  year: number;
  name: string;
  starts_on: string;
  ends_on: string;
  is_current: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, year, name, starts_on, ends_on, is_current, created_at, updated_at';

function toCycle(r: CycleRow): LearningCycle {
  return {
    id: r.id,
    year: r.year,
    name: r.name,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    isCurrent: r.is_current,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class PgCycleRepository implements CycleRepository {
  constructor(private readonly db: SqlExecutor) {}

  async list(): Promise<LearningCycle[]> {
    const res = await this.db.query<CycleRow>(`select ${COLUMNS} from learning_cycles order by year desc`);
    return res.rows.map(toCycle);
  }

  async findById(id: string): Promise<LearningCycle | null> {
    const res = await this.db.query<CycleRow>(`select ${COLUMNS} from learning_cycles where id = $1`, [id]);
    return res.rows[0] ? toCycle(res.rows[0]) : null;
  }

  async findByYear(year: number): Promise<LearningCycle | null> {
    const res = await this.db.query<CycleRow>(`select ${COLUMNS} from learning_cycles where year = $1`, [year]);
    return res.rows[0] ? toCycle(res.rows[0]) : null;
  }

  async findCurrent(): Promise<LearningCycle | null> {
    const res = await this.db.query<CycleRow>(`select ${COLUMNS} from learning_cycles where is_current`);
    return res.rows[0] ? toCycle(res.rows[0]) : null;
  }

  async create(c: NewLearningCycle): Promise<LearningCycle> {
    try {
      const res = await this.db.query<CycleRow>(
        `insert into learning_cycles (year, name, starts_on, ends_on) values ($1, $2, $3, $4) returning ${COLUMNS}`,
        [c.year, c.name, c.startsOn, c.endsOn],
      );
      return toCycle(res.rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`A ${c.year} learning year already exists.`, 'CYCLE_EXISTS');
      throw err;
    }
  }

  async update(id: string, changes: Partial<Pick<LearningCycle, 'name' | 'startsOn' | 'endsOn'>>): Promise<LearningCycle> {
    const res = await this.db.query<CycleRow>(
      `update learning_cycles set
         name = coalesce($2, name), starts_on = coalesce($3::date, starts_on), ends_on = coalesce($4::date, ends_on)
       where id = $1 returning ${COLUMNS}`,
      [id, changes.name ?? null, changes.startsOn ?? null, changes.endsOn ?? null],
    );
    if (!res.rows[0]) throw new NotFoundError('learning year', 'CYCLE_NOT_FOUND');
    return toCycle(res.rows[0]);
  }

  async setCurrent(id: string): Promise<void> {
    // Two statements so the partial unique index never sees two current rows.
    await this.db.query('update learning_cycles set is_current = false where is_current and id <> $1', [id]);
    const res = await this.db.query('update learning_cycles set is_current = true where id = $1', [id]);
    if (res.rowCount === 0) throw new NotFoundError('learning year', 'CYCLE_NOT_FOUND');
  }
}
