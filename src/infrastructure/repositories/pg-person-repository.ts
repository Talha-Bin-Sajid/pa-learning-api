import type { NewPerson, Person, PersonChanges } from '../../domain/entities/person.js';
import type { PersonFilter, PersonRepository } from '../../domain/repositories/person-repository.js';
import { ConflictError, NotFoundError } from '../../shared/errors/app-errors.js';
import type { SqlExecutor } from '../database/database.js';
import { isUniqueViolation } from '../database/pg-errors.js';

interface PersonRow {
  id: string;
  auth_user_id: string | null;
  full_name: string;
  email: string;
  role: Person['role'];
  designation_id: number | null;
  reporting_access: Person['reportingAccess'];
  line_manager_id: string | null;
  status: Person['status'];
  avatar_color: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, auth_user_id, full_name, email, role, designation_id, reporting_access,
  line_manager_id, status, avatar_color, last_seen_at, created_at, updated_at`;

const CHANGE_COLUMNS: Record<keyof PersonChanges, string> = {
  fullName: 'full_name',
  email: 'email',
  role: 'role',
  designationId: 'designation_id',
  reportingAccess: 'reporting_access',
  lineManagerId: 'line_manager_id',
  status: 'status',
  authUserId: 'auth_user_id',
};

function toPerson(r: PersonRow): Person {
  return {
    id: r.id,
    authUserId: r.auth_user_id,
    fullName: r.full_name,
    email: r.email,
    role: r.role,
    designationId: r.designation_id,
    reportingAccess: r.reporting_access,
    lineManagerId: r.line_manager_id,
    status: r.status,
    avatarColor: r.avatar_color,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function translate(err: unknown): never {
  if (isUniqueViolation(err, 'profiles_email_lower_key')) {
    throw new ConflictError('Someone with this email already exists.', 'EMAIL_TAKEN');
  }
  if (isUniqueViolation(err, 'profiles_auth_user_id_key')) {
    throw new ConflictError('This sign-in account is already linked to another person.', 'ACCOUNT_ALREADY_LINKED');
  }
  throw err;
}

export class PgPersonRepository implements PersonRepository {
  constructor(private readonly db: SqlExecutor) {}

  async findById(id: string): Promise<Person | null> {
    const res = await this.db.query<PersonRow>(`select ${COLUMNS} from profiles where id = $1`, [id]);
    return res.rows[0] ? toPerson(res.rows[0]) : null;
  }

  async findByAuthUserId(authUserId: string): Promise<Person | null> {
    const res = await this.db.query<PersonRow>(`select ${COLUMNS} from profiles where auth_user_id = $1`, [authUserId]);
    return res.rows[0] ? toPerson(res.rows[0]) : null;
  }

  async findByEmail(email: string): Promise<Person | null> {
    const res = await this.db.query<PersonRow>(`select ${COLUMNS} from profiles where lower(email) = lower($1)`, [email]);
    return res.rows[0] ? toPerson(res.rows[0]) : null;
  }

  async findByEmails(emails: string[]): Promise<Person[]> {
    if (emails.length === 0) return [];
    const res = await this.db.query<PersonRow>(
      `select ${COLUMNS} from profiles where lower(email) = any($1::text[])`,
      [emails.map((e) => e.toLowerCase())],
    );
    return res.rows.map(toPerson);
  }

  async list(filter: PersonFilter = {}): Promise<Person[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: (n: string) => string, value: unknown) => {
      params.push(value);
      where.push(clause(`$${params.length}`));
    };
    if (filter.search) {
      add((p) => `(full_name ilike ${p} or email ilike ${p})`, `%${filter.search.replace(/[%_\\]/g, '\\$&')}%`);
    }
    if (filter.role) add((p) => `role = ${p}`, filter.role);
    if (filter.status) add((p) => `status = ${p}`, filter.status);
    if (filter.ids) add((p) => `id = any(${p}::uuid[])`, filter.ids);
    if (filter.lineManagerId) add((p) => `line_manager_id = ${p}`, filter.lineManagerId);
    const res = await this.db.query<PersonRow>(
      `select ${COLUMNS} from profiles ${where.length ? `where ${where.join(' and ')}` : ''} order by full_name`,
      params,
    );
    return res.rows.map(toPerson);
  }

  async count(): Promise<number> {
    const res = await this.db.query<{ n: number }>('select count(*)::int as n from profiles');
    return res.rows[0]?.n ?? 0;
  }

  async create(p: NewPerson): Promise<Person> {
    try {
      const res = await this.db.query<PersonRow>(
        `insert into profiles (full_name, email, auth_user_id, role, designation_id, reporting_access, line_manager_id, status, avatar_color)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${COLUMNS}`,
        [
          p.fullName,
          p.email,
          p.authUserId ?? null,
          p.role,
          p.designationId,
          p.reportingAccess,
          p.lineManagerId,
          p.status,
          p.avatarColor,
        ],
      );
      return toPerson(res.rows[0]!);
    } catch (err) {
      translate(err);
    }
  }

  async update(id: string, changes: PersonChanges): Promise<Person> {
    const entries = Object.entries(changes).filter(([, v]) => v !== undefined) as [keyof PersonChanges, unknown][];
    if (entries.length === 0) {
      const current = await this.findById(id);
      if (!current) throw new NotFoundError('person');
      return current;
    }
    const sets = entries.map(([k], i) => `${CHANGE_COLUMNS[k]} = $${i + 2}`);
    try {
      const res = await this.db.query<PersonRow>(
        `update profiles set ${sets.join(', ')} where id = $1 returning ${COLUMNS}`,
        [id, ...entries.map(([, v]) => v)],
      );
      if (!res.rows[0]) throw new NotFoundError('person');
      return toPerson(res.rows[0]);
    } catch (err) {
      translate(err);
    }
  }

  async touchLastSeen(id: string): Promise<void> {
    // Throttled: at most one write per person per 5 minutes.
    await this.db.query(
      `update profiles set last_seen_at = now()
       where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')`,
      [id],
    );
  }
}
