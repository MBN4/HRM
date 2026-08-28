import { apiFetch } from './client';
import type { WorkflowInstanceDetail, WorkflowInstanceStep } from './types';

export function getMyPendingApprovals(): Promise<WorkflowInstanceStep[]> {
  return apiFetch<WorkflowInstanceStep[]>('/workflow/my-pending-approvals');
}

export function getWorkflowInstance(id: string): Promise<WorkflowInstanceDetail> {
  return apiFetch<WorkflowInstanceDetail>(`/workflow/instances/${id}`);
}

export type WorkflowActionType = 'APPROVE' | 'REJECT' | 'DELEGATE' | 'COMMENT';

export function actOnWorkflowStep(
  instanceId: string,
  stepId: string,
  input: { actionType: WorkflowActionType; delegatedToUserId?: string; comment?: string },
) {
  return apiFetch(`/workflow/instances/${instanceId}/steps/${stepId}/actions`, { method: 'POST', body: input });
}

export function cancelWorkflowInstance(instanceId: string) {
  return apiFetch(`/workflow/instances/${instanceId}/cancel`, { method: 'POST' });
}
