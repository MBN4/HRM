/**
 * Structured domain events for every workflow state change, emitted via
 * `@nestjs/event-emitter` and consumed today only by
 * `workflow/listeners/workflow-events.listener.ts` (which just logs
 * them) — the same deferred-persistence pattern `auth-events.ts`/
 * `licensing-events.ts` document: the notification hub (0.8) and the real
 * audit log (0.9) both consume this contract instead of this listener's
 * implementation, without `WorkflowEngineService` changing.
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
