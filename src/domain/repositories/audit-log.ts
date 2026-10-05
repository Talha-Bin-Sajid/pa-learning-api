export interface AuditEvent {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditLog {
  record(event: AuditEvent): Promise<void>;
}
