import { apiFetch } from './client';
import type { ChecklistTaskDefinition, ChecklistTaskInstance, ChecklistTemplate, OnboardingProcess } from './types';

export function listOnboardingProcesses(): Promise<OnboardingProcess[]> {
  return apiFetch<OnboardingProcess[]>('/onboarding/processes');
}

export function getOnboardingProcess(id: string): Promise<OnboardingProcess & { tasks: ChecklistTaskInstance[] }> {
  return apiFetch(`/onboarding/processes/${id}`);
}

/**
 * Everything `createEmployeeSchema` (1.1) still requires after
 * `completeOnboardingSchema` omits the identity/lifecycle fields
 * `OnboardingService` already sources from the accepted `Offer`/`Candidate`
 * — most importantly `statutoryFields`, since enforcing the new hire's
 * branch country pack's required fields is the whole point of this route.
 * The response is loosely typed below: the portal only needs to confirm
 * success/id here, never render this response in detail.
 */
export interface CreateEmployeeFromOnboardingInput {
  employeeCode: string;
  departmentId?: string;
  designationId?: string;
  managerId?: string;
  statutoryFields: Record<string, string>;
  bankDetails?: { accountNumber?: string; bankName?: string; routingCode?: string };
  compensation?: { baseSalary?: number; currency?: string };
  dependents?: unknown[];
  emergencyContacts?: unknown[];
  customFields?: Record<string, unknown>;
  /** Defaults server-side to the accepted Offer's `proposedJoinDate` when omitted. */
  joinDate?: string;
}

export function createEmployeeFromOnboarding(
  processId: string,
  input: CreateEmployeeFromOnboardingInput,
  params: { checklistTemplateName?: string } = {},
): Promise<{ id: string; [key: string]: unknown }> {
  return apiFetch(`/onboarding/processes/${processId}/create-employee`, { method: 'POST', body: input, query: params });
}

export function getMyOnboardingTasks(): Promise<ChecklistTaskInstance[]> {
  return apiFetch<ChecklistTaskInstance[]>('/onboarding/my-tasks');
}

export function completeOnboardingTask(id: string, document?: File | null): Promise<ChecklistTaskInstance> {
  if (!document) {
    return apiFetch<ChecklistTaskInstance>(`/onboarding/tasks/${id}/complete`, { method: 'POST' });
  }
  const form = new FormData();
  form.set('document', document);
  return apiFetch<ChecklistTaskInstance>(`/onboarding/tasks/${id}/complete`, { method: 'POST', body: form });
}

export interface UpsertChecklistTemplateInput {
  processType: 'ONBOARDING';
  name: string;
  tasks: ChecklistTaskDefinition[];
}

export function upsertOnboardingChecklistTemplate(input: UpsertChecklistTemplateInput): Promise<ChecklistTemplate> {
  return apiFetch<ChecklistTemplate>('/onboarding/checklist-templates', { method: 'POST', body: input });
}

export function listOnboardingChecklistTemplates(): Promise<ChecklistTemplate[]> {
  return apiFetch<ChecklistTemplate[]>('/onboarding/checklist-templates');
}
