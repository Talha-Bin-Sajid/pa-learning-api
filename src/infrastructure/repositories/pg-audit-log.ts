import type { AuditEvent, AuditLog } from '../../domain/repositories/audit-log.js';
import type { SqlExecutor } from '../database/database.js';

export class PgAuditLog implements AuditLog {
  constructor(private readonly db: SqlExecutor) {}

  async record(e: AuditEvent): Promise<void> {
    await this.db.query(
      `insert into audit_events (actor_id, action, entity_type, entity_id, metadata) values ($1, $2, $3, $4, $5::jsonb)`,
      [e.actorId, e.action, e.entityType, e.entityId ?? null, JSON.stringify(e.metadata ?? {})],
    );
  }
}
