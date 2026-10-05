import type { EvidenceCheck, EvidenceCheckResult } from '../../domain/entities/evidence-check.js';
import type { EvidenceCheckRepository } from '../../domain/repositories/evidence-check-repository.js';
import type { EvidenceAnalysis } from '../../domain/value-objects/evidence-analysis.js';
import type { SqlExecutor } from '../database/database.js';

interface CheckRow {
  id: string;
  completion_id: string;
  evidence_path: string;
  status: EvidenceCheck['status'];
  attempts: number;
  next_attempt_at: Date;
  provider: string | null;
  model: string | null;
  analysis: EvidenceAnalysis | null;
  decision: EvidenceCheck['decision'];
  reasons: string[];
  confidence: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const COLUMNS = `id, completion_id, evidence_path, status, attempts, next_attempt_at, provider, model, analysis, decision,
  reasons, confidence, input_tokens, output_tokens, error, created_at, started_at, finished_at`;

const toCheck = (r: CheckRow): EvidenceCheck => ({
  id: r.id,
  completionId: r.completion_id,
  evidencePath: r.evidence_path,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  provider: r.provider,
  model: r.model,
  analysis: typeof r.analysis === 'string' ? (JSON.parse(r.analysis) as EvidenceAnalysis) : r.analysis,
  decision: r.decision,
  reasons: r.reasons ?? [],
  confidence: r.confidence === null ? null : Number(r.confidence),
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export class PgEvidenceCheckRepository implements EvidenceCheckRepository {
  constructor(private readonly db: SqlExecutor) {}

  async enqueue(completionId: string, evidencePath: string): Promise<EvidenceCheck> {
    await this.db.query(
      `update evidence_checks set status = 'superseded', finished_at = now()
       where completion_id = $1 and status in ('queued', 'running')`,
      [completionId],
    );
    const res = await this.db.query<CheckRow>(
      `insert into evidence_checks (completion_id, evidence_path) values ($1, $2) returning ${COLUMNS}`,
      [completionId, evidencePath],
    );
    return toCheck(res.rows[0]!);
  }

  async claimNext(): Promise<EvidenceCheck | null> {
    // SKIP LOCKED: safe even if several API instances run a worker.
    const res = await this.db.query<CheckRow>(
      `update evidence_checks set status = 'running', attempts = attempts + 1, started_at = now()
       where id = (
         select id from evidence_checks
         where status = 'queued' and next_attempt_at <= now()
         order by next_attempt_at
         limit 1
         for update skip locked
       )
       returning ${COLUMNS}`,
    );
    return res.rows[0] ? toCheck(res.rows[0]) : null;
  }

  async complete(id: string, r: EvidenceCheckResult): Promise<boolean> {
    const res = await this.db.query(
      `update evidence_checks set status = 'done', provider = $2, model = $3, analysis = $4::jsonb, decision = $5,
         reasons = $6, confidence = $7, input_tokens = $8, output_tokens = $9, error = null, finished_at = now()
       where id = $1 and status = 'running'`,
      [
        id,
        r.provider,
        r.model,
        JSON.stringify(r.analysis),
        r.decision,
        r.reasons,
        Math.max(0, Math.min(1, r.analysis.confidence)),
        r.inputTokens,
        r.outputTokens,
      ],
    );
    return res.rowCount > 0;
  }

  async fail(id: string, error: string, retryInMs: number | null): Promise<boolean> {
    const res = await this.db.query(
      retryInMs !== null
        ? `update evidence_checks set status = 'queued', error = $2, next_attempt_at = now() + make_interval(secs => $3)
           where id = $1 and status = 'running'`
        : `update evidence_checks set status = 'failed', error = $2, finished_at = now() where id = $1 and status = 'running'`,
      retryInMs !== null ? [id, error.slice(0, 1000), retryInMs / 1000] : [id, error.slice(0, 1000)],
    );
    return res.rowCount > 0;
  }

  async supersede(id: string): Promise<void> {
    await this.db.query(`update evidence_checks set status = 'superseded', finished_at = now() where id = $1`, [id]);
  }

  async requeueStale(olderThanMs: number): Promise<number> {
    const res = await this.db.query(
      `update evidence_checks set status = 'queued', next_attempt_at = now()
       where status = 'running' and started_at < now() - make_interval(secs => $1)`,
      [olderThanMs / 1000],
    );
    return res.rowCount;
  }

  async latestFor(completionIds: string[]): Promise<Map<string, EvidenceCheck>> {
    if (completionIds.length === 0) return new Map();
    const res = await this.db.query<CheckRow>(
      `select distinct on (completion_id) ${COLUMNS} from evidence_checks
       where completion_id = any($1::uuid[]) and status <> 'superseded'
       order by completion_id, created_at desc`,
      [completionIds],
    );
    return new Map(res.rows.map((r) => [r.completion_id, toCheck(r)]));
  }
}
