import type { Completion, CompletionUpsert, ReviewDecision } from '../../domain/entities/completion.js';
import type { CompletionRepository } from '../../domain/repositories/completion-repository.js';
import { NotFoundError } from '../../shared/errors/app-errors.js';
import type { SqlExecutor } from '../database/database.js';

interface CompletionRow {
  id: string;
  profile_id: string;
  item_id: string;
  completed_on: string;
  reflection: string | null;
  evidence_path: string | null;
  evidence_file_name: string | null;
  evidence_mime_type: string | null;
  evidence_size_bytes: number | null;
  evidence_sha256: string | null;
  review_status: Completion['reviewStatus'];
  review_source: Completion['reviewSource'];
  review_notes: string | null;
  reviewed_at: Date | null;
  submitted_at: Date;
  updated_at: Date;
}

const COLUMNS = `c.id, c.profile_id, c.item_id, c.completed_on, c.reflection, c.evidence_path, c.evidence_file_name,
  c.evidence_mime_type, c.evidence_size_bytes, c.evidence_sha256, c.review_status, c.review_source, c.review_notes,
  c.reviewed_at, c.submitted_at, c.updated_at`;

function toCompletion(r: CompletionRow): Completion {
  return {
    id: r.id,
    profileId: r.profile_id,
    itemId: r.item_id,
    completedOn: r.completed_on,
    reflection: r.reflection,
    evidence: r.evidence_path
      ? {
          path: r.evidence_path,
          fileName: r.evidence_file_name!,
          mimeType: r.evidence_mime_type!,
          sizeBytes: Number(r.evidence_size_bytes),
        }
      : null,
    evidenceSha256: r.evidence_sha256,
    reviewStatus: r.review_status,
    reviewSource: r.review_source,
    reviewNotes: r.review_notes,
    reviewedAt: r.reviewed_at,
    submittedAt: r.submitted_at,
    updatedAt: r.updated_at,
  };
}

export class PgCompletionRepository implements CompletionRepository {
  constructor(private readonly db: SqlExecutor) {}

  async listByCycle(cycleId: string): Promise<Completion[]> {
    const res = await this.db.query<CompletionRow>(
      `select ${COLUMNS} from completions c join learning_items i on i.id = c.item_id where i.cycle_id = $1
       order by c.completed_on desc`,
      [cycleId],
    );
    return res.rows.map(toCompletion);
  }

  async findById(id: string): Promise<Completion | null> {
    const res = await this.db.query<CompletionRow>(`select ${COLUMNS} from completions c where c.id = $1`, [id]);
    return res.rows[0] ? toCompletion(res.rows[0]) : null;
  }

  async find(profileId: string, itemId: string): Promise<Completion | null> {
    const res = await this.db.query<CompletionRow>(
      `select ${COLUMNS} from completions c where c.profile_id = $1 and c.item_id = $2`,
      [profileId, itemId],
    );
    return res.rows[0] ? toCompletion(res.rows[0]) : null;
  }

  async upsert(c: CompletionUpsert): Promise<Completion> {
    // Replacing evidence resets any earlier review (it is a new submission).
    const res = await this.db.query<CompletionRow>(
      `insert into completions as c (profile_id, item_id, completed_on, reflection, evidence_path, evidence_file_name,
         evidence_mime_type, evidence_size_bytes, evidence_sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (profile_id, item_id) do update set
         completed_on = excluded.completed_on, reflection = excluded.reflection,
         evidence_path = excluded.evidence_path, evidence_file_name = excluded.evidence_file_name,
         evidence_mime_type = excluded.evidence_mime_type, evidence_size_bytes = excluded.evidence_size_bytes,
         evidence_sha256 = excluded.evidence_sha256,
         review_status = 'not_reviewed', review_source = null, review_notes = null, reviewed_by = null, reviewed_at = null,
         submitted_at = now()
       returning ${COLUMNS}`,
      [
        c.profileId,
        c.itemId,
        c.completedOn,
        c.reflection,
        c.evidence?.path ?? null,
        c.evidence?.fileName ?? null,
        c.evidence?.mimeType ?? null,
        c.evidence?.sizeBytes ?? null,
        c.evidenceSha256,
      ],
    );
    return toCompletion(res.rows[0]!);
  }

  async countBySha256(sha256: string, excludeCompletionId: string): Promise<number> {
    const res = await this.db.query<{ n: number }>(
      'select count(*)::int as n from completions where evidence_sha256 = $1 and id <> $2',
      [sha256, excludeCompletionId],
    );
    return res.rows[0]?.n ?? 0;
  }

  async setReview(id: string, d: ReviewDecision): Promise<Completion> {
    const res = await this.db.query<CompletionRow>(
      `update completions as c set review_status = $2, review_source = $3, review_notes = $4, reviewed_by = $5, reviewed_at = now()
       where c.id = $1 returning ${COLUMNS}`,
      [id, d.status, d.source, d.notes, d.reviewedBy],
    );
    if (!res.rows[0]) throw new NotFoundError('completion', 'COMPLETION_NOT_FOUND');
    return toCompletion(res.rows[0]);
  }
}
