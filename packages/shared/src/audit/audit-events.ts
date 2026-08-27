/**
 * Common HTTP-mutation action verbs for `@AuditLog()` (see
 * `apps/api/src/audit/audit-log.decorator.ts`). `AuditLog.action` itself
 * stays a free-form string at the DB layer — same reasoning as
 * `WorkflowInstance.entityType`/`Notification.eventType` — since a
 * domain-event-sourced entry's `action` is that event's own type string
 * (e.g. `"workflow.approved"`), not one of these.
 */
export const AUDIT_ACTIONS = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
} as const;

export type AuditActionKey = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Shape returned by `GET /audit` — see AuditQueryService. */
export interface AuditLogEntryDto {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorPlatform: boolean;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}
