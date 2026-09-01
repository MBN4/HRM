import { apiFetch, apiFetchBlob } from './client';
import { triggerBrowserDownload } from '../download';
import type { PayrollComponentDefinition, PayrollComponentType, PayrollRun } from './types';

export interface CreatePayrollRunInput {
  branchId: string;
  periodYear: number;
  periodMonth: number;
}

export function createPayrollRun(input: CreatePayrollRunInput): Promise<PayrollRun> {
  return apiFetch<PayrollRun>('/payroll/runs', { method: 'POST', body: input });
}

export function calculatePayrollRun(id: string): Promise<{ enqueued: boolean }> {
  return apiFetch(`/payroll/runs/${id}/calculate`, { method: 'POST' });
}

export function getPayrollRun(id: string): Promise<PayrollRun> {
  return apiFetch<PayrollRun>(`/payroll/runs/${id}`);
}

export function listPayrollRuns(params: { branchId?: string; periodYear?: number; periodMonth?: number } = {}): Promise<PayrollRun[]> {
  return apiFetch<PayrollRun[]>('/payroll/runs', { query: params });
}

export function submitPayrollRunForApproval(id: string): Promise<{ submitted: boolean }> {
  return apiFetch(`/payroll/runs/${id}/submit-for-approval`, { method: 'POST' });
}

export function finalizePayrollRun(id: string): Promise<{ finalized: boolean }> {
  return apiFetch(`/payroll/runs/${id}/finalize`, { method: 'POST' });
}

export function markPayrollRunPaid(id: string): Promise<{ paid: boolean }> {
  return apiFetch(`/payroll/runs/${id}/mark-paid`, { method: 'POST' });
}

/** Fetches the run's bank-export CSV and immediately triggers a browser download — see `apiFetchBlob`/`triggerBrowserDownload`. */
export async function bankExportPayrollRun(id: string): Promise<void> {
  // The backend route is `@Post('runs/:id/bank-export')` (it creates a new
  // `PayrollBankExport` row each call, so a plain GET wouldn't be correct
  // semantics even if the server allowed it) — see `apiFetchBlob`'s `method` option.
  const { blob, filename } = await apiFetchBlob(`/payroll/runs/${id}/bank-export`, { method: 'POST' });
  triggerBrowserDownload(blob, filename ?? `payroll-${id}-bank-export.csv`);
}

/** Fetches one employee's payslip PDF for a run and immediately triggers a browser download. */
export async function downloadPayslip(runId: string, employeeId: string): Promise<void> {
  const { blob, filename } = await apiFetchBlob(`/payroll/runs/${runId}/payslips/${employeeId}`);
  triggerBrowserDownload(blob, filename ?? `payslip-${employeeId}.pdf`);
}

interface PayrollComponentBaseInput {
  countryCode: string;
  key: string;
  name: string;
  type: PayrollComponentType;
  order: number;
  isActive: boolean;
}

export type UpsertPayrollComponentInput =
  | (PayrollComponentBaseInput & { calcKind: 'FIXED_AMOUNT'; fixedAmount: number })
  | (PayrollComponentBaseInput & { calcKind: 'PERCENTAGE_OF_BASE'; percentageOfBase: 'basicSalary'; percentageRate: number })
  | (PayrollComponentBaseInput & { calcKind: 'FORMULA'; formula: unknown });

export function upsertPayrollComponent(input: UpsertPayrollComponentInput): Promise<PayrollComponentDefinition> {
  return apiFetch<PayrollComponentDefinition>('/payroll/components', { method: 'POST', body: input });
}

export function listPayrollComponents(params: { countryCode?: string } = {}): Promise<PayrollComponentDefinition[]> {
  return apiFetch<PayrollComponentDefinition[]>('/payroll/components', { query: params });
}
