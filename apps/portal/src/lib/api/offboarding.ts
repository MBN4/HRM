import { apiFetch } from './client';
import type { ChecklistTaskDefinition, ChecklistTaskInstance, ChecklistTemplate, OffboardingProcess, OffboardingReason } from './types';

export interface InitiateOffboardingInput {
  employeeId: string;
  reason: OffboardingReason;
  lastWorkingDate: string;
}

export function initiateOffboarding(input: InitiateOffboardingInput): Promise<OffboardingProcess> {
  return apiFetch<OffboardingProcess>('/offboarding/processes', { method: 'POST', body: input });
}

export function listOffboardingProcesses(): Promise<OffboardingProcess[]> {
  return apiFetch<OffboardingProcess[]>('/offboarding/processes');
}

export function getOffboardingProcess(id: string): Promise<OffboardingProcess & { tasks: ChecklistTaskInstance[] }> {
  return apiFetch(`/offboarding/processes/${id}`);
}

/** Gated (service-side) on every checklist task for this process already being `COMPLETED`. On success, the response's `settlementPayrollRunId` links to the FINAL_SETTLEMENT Payroll run this action creates. */
export function completeOffboardingProcess(id: string): Promise<OffboardingProcess> {
  return apiFetch<OffboardingProcess>(`/offboarding/processes/${id}/complete`, { method: 'POST' });
}

export function getMyOffboardingTasks(): Promise<ChecklistTaskInstance[]> {
  return apiFetch<ChecklistTaskInstance[]>('/offboarding/my-tasks');
}

export function completeOffboardingTask(id: string, document?: File | null): Promise<ChecklistTaskInstance> {
  if (!document) {
    return apiFetch<ChecklistTaskInstance>(`/offboarding/tasks/${id}/complete`, { method: 'POST' });
  }
  const form = new FormData();
  form.set('document', document);
  return apiFetch<ChecklistTaskInstance>(`/offboarding/tasks/${id}/complete`, { method: 'POST', body: form });
}

export interface UpsertChecklistTemplateInput {
  processType: 'OFFBOARDING';
  name: string;
  tasks: ChecklistTaskDefinition[];
}

export function upsertOffboardingChecklistTemplate(input: UpsertChecklistTemplateInput): Promise<ChecklistTemplate> {
  return apiFetch<ChecklistTemplate>('/offboarding/checklist-templates', { method: 'POST', body: input });
}

export function listOffboardingChecklistTemplates(): Promise<ChecklistTemplate[]> {
  return apiFetch<ChecklistTemplate[]>('/offboarding/checklist-templates');
}
