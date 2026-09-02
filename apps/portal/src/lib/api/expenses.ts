import { apiFetch, apiFetchBlob } from './client';
import { triggerBrowserDownload } from '../download';
import type { ExpenseCategory, ExpenseClaim, ExpenseLine } from './types';

export interface CreateExpenseCategoryInput {
  code: string;
  name: string;
  policyLimitAmount?: number;
}

export function upsertExpenseCategory(input: CreateExpenseCategoryInput): Promise<ExpenseCategory> {
  return apiFetch<ExpenseCategory>('/expenses/categories', { method: 'POST', body: input });
}

export function listExpenseCategories(): Promise<ExpenseCategory[]> {
  return apiFetch<ExpenseCategory[]>('/expenses/categories');
}

export function createExpenseClaimDraft(employeeId?: string): Promise<ExpenseClaim> {
  return apiFetch<ExpenseClaim>('/expenses/claims', { method: 'POST', body: { employeeId } });
}

export interface AddExpenseLineInput {
  categoryId: string;
  description: string;
  amount: number;
  expenseDate: string;
}

export function addExpenseLine(claimId: string, input: AddExpenseLineInput): Promise<ExpenseLine> {
  return apiFetch<ExpenseLine>(`/expenses/claims/${claimId}/lines`, { method: 'POST', body: input });
}

export function removeExpenseLine(claimId: string, lineId: string): Promise<{ removed: boolean }> {
  return apiFetch<{ removed: boolean }>(`/expenses/claims/${claimId}/lines/${lineId}`, { method: 'DELETE' });
}

export async function uploadReceipt(claimId: string, lineId: string, file: File): Promise<ExpenseLine> {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch<ExpenseLine>(`/expenses/claims/${claimId}/lines/${lineId}/receipt`, { method: 'POST', body: formData });
}

export async function downloadReceipt(claimId: string, lineId: string, filename: string): Promise<void> {
  const { blob } = await apiFetchBlob(`/expenses/claims/${claimId}/lines/${lineId}/receipt`);
  triggerBrowserDownload(blob, filename);
}

export function submitExpenseClaim(claimId: string): Promise<ExpenseClaim> {
  return apiFetch<ExpenseClaim>(`/expenses/claims/${claimId}/submit`, { method: 'POST' });
}

export function listExpenseClaims(params: { employeeId?: string; status?: string } = {}): Promise<ExpenseClaim[]> {
  return apiFetch<ExpenseClaim[]>('/expenses/claims', { query: params });
}

export function getExpenseClaim(id: string): Promise<ExpenseClaim> {
  return apiFetch<ExpenseClaim>(`/expenses/claims/${id}`);
}
