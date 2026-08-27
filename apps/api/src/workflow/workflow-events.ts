/**
 * Structured domain events for every workflow state change, emitted via
 * `@nestjs/event-emitter` and consumed by the notification hub's
 * `NotificationDispatchListener` (0.8) and audit's
 * `DomainEventAuditListener` (0.9, persisting into `audit_log`) — the
 * same contract `auth-events.ts`/`licensing-events.ts` document, without
 * `WorkflowEngineService` changing.
 */
export const WORKFLOW_EVENTS = {
  SUBMITTED: 'workflow.submitted',
  STEP_APPROVED: 'workflow.step_approved',
  APPROVED: 'workflow.approved',
  REJECTED: 'workflow.rejected',
  ESCALATED: 'workflow.escalated',
  DELEGATED: 'workflow.delegated',
  CANCELED: 'workflow.canceled',
} as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENTS)[keyof typeof WORKFLOW_EVENTS];

export interface WorkflowEventPayload {
  type: WorkflowEventType;
  tenantId: string;
  instanceId: string;
  [key: string]: unknown;
}
