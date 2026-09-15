import { apiFetch, apiFetchBlob } from './client';
import { triggerBrowserDownload } from '../download';

export type DataSubjectType = 'EMPLOYEE' | 'CANDIDATE' | 'USER';
export type PrivacyRequestType = 'EXPORT' | 'ERASURE';
export type PrivacyRequestStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REJECTED';
export type DataCategory = 'EMPLOYEE_PROFILE' | 'EMPLOYEE_POST_EXIT' | 'CANDIDATE_RECORDS' | 'PAYROLL_TAX_RECORDS' | 'AUDIT_TRAIL' | 'DOCUMENTS';

export interface DataSubjectRequest {
  id: string;
  requestType: PrivacyRequestType;
  subjectType: DataSubjectType;
  subjectId: string;
  status: PrivacyRequestStatus;
  reason: string | null;
  resultStorageKey: string | null;
  erasureSummary: Record<string, { action: string; note: string; count?: number }> | null;
  failureReason: string | null;
  systemInitiated: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface ConsentRecord {
  id: string;
  subjectType: DataSubjectType;
  subjectId: string;
  purpose: string;
  granted: boolean;
  source: string;
  grantedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ProcessingRegisterEntry {
  category: DataCategory;
  description: string;
  purposeOfProcessing: string;
  legalBasis: string;
  dataSubjectTypes: DataSubjectType[];
  sourceModules: string[];
}

export interface SubProcessorRecord {
  id: string;
  name: string;
  purpose: string;
  dataCategories: DataCategory[];
  region: string;
  contractReference: string | null;
}

export interface EffectiveRetentionPolicy {
  category: DataCategory;
  retentionMonths: number;
  action: 'HARD_DELETE' | 'ANONYMIZE' | 'RETAIN_LEGAL';
  legalBasisNote: string | null;
  tenantOverrideApplied: boolean;
  autoEnforced: boolean;
}

export function createDataSubjectRequest(input: { requestType: PrivacyRequestType; subjectType: DataSubjectType; subjectId: string; reason?: string }): Promise<DataSubjectRequest> {
  return apiFetch<DataSubjectRequest>('/privacy/requests', { method: 'POST', body: input });
}

export function listDataSubjectRequests(): Promise<DataSubjectRequest[]> {
  return apiFetch<DataSubjectRequest[]>('/privacy/requests');
}

export function getDataSubjectRequest(id: string): Promise<DataSubjectRequest> {
  return apiFetch<DataSubjectRequest>(`/privacy/requests/${id}`);
}

export async function downloadDataSubjectExport(id: string): Promise<void> {
  const { blob, filename } = await apiFetchBlob(`/privacy/requests/${id}/export`);
  triggerBrowserDownload(blob, filename ?? `export-${id}.json`);
}

export function recordConsent(input: { subjectType: DataSubjectType; subjectId: string; purpose: string; granted: boolean; source: string }): Promise<ConsentRecord> {
  return apiFetch<ConsentRecord>('/privacy/consents', { method: 'POST', body: input });
}

export function listConsentRecords(params: { subjectType?: DataSubjectType; subjectId?: string } = {}): Promise<ConsentRecord[]> {
  return apiFetch<ConsentRecord[]>('/privacy/consents', { query: params });
}

export function listProcessingRegister(): Promise<ProcessingRegisterEntry[]> {
  return apiFetch<ProcessingRegisterEntry[]>('/privacy/register');
}

export function listSubProcessors(): Promise<SubProcessorRecord[]> {
  return apiFetch<SubProcessorRecord[]>('/privacy/sub-processors');
}

export function listEffectiveRetentionPolicies(): Promise<EffectiveRetentionPolicy[]> {
  return apiFetch<EffectiveRetentionPolicy[]>('/privacy/retention-policies');
}

export function setTenantRetentionOverride(category: DataCategory, retentionMonths: number): Promise<unknown> {
  return apiFetch(`/privacy/retention-policies/${category}`, { method: 'PUT', body: { retentionMonths } });
}

export function removeTenantRetentionOverride(category: DataCategory): Promise<void> {
  return apiFetch<void>(`/privacy/retention-policies/${category}`, { method: 'DELETE' });
}
