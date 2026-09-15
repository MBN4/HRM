import { apiFetch } from './client';

export interface ProcessingRegisterEntry {
  category: string;
  description: string;
  purposeOfProcessing: string;
  legalBasis: string;
  dataSubjectTypes: string[];
  sourceModules: string[];
}

export interface RetentionPolicy {
  category: string;
  retentionMonths: number;
  action: 'HARD_DELETE' | 'ANONYMIZE' | 'RETAIN_LEGAL';
  legalBasisNote: string | null;
}

export interface SubProcessorRecord {
  id: string;
  name: string;
  purpose: string;
  dataCategories: string[];
  region: string;
  contractReference: string | null;
}

export interface ResidencyOverviewRow {
  tenantId: string;
  tenantName: string;
  hostingRegion: string;
  thisDeploymentRegion: string | null;
  matchesThisDeployment: boolean | null;
}

export interface DataSubjectRequestSummary {
  id: string;
  tenantId: string;
  requestType: 'EXPORT' | 'ERASURE';
  subjectType: 'EMPLOYEE' | 'CANDIDATE' | 'USER';
  subjectId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REJECTED';
  systemInitiated: boolean;
  createdAt: string;
}

export function listRegister(): Promise<ProcessingRegisterEntry[]> {
  return apiFetch('/platform/privacy/register');
}

export function listRetentionPolicies(): Promise<RetentionPolicy[]> {
  return apiFetch('/platform/privacy/retention-policies');
}

export function updateRetentionPolicy(category: string, input: { retentionMonths?: number; action?: string; legalBasisNote?: string }): Promise<RetentionPolicy> {
  return apiFetch(`/platform/privacy/retention-policies/${category}`, { method: 'PUT', body: input });
}

export function listSubProcessors(): Promise<SubProcessorRecord[]> {
  return apiFetch('/platform/privacy/sub-processors');
}

export function createSubProcessor(input: { name: string; purpose: string; dataCategories: string[]; region: string }): Promise<SubProcessorRecord> {
  return apiFetch('/platform/privacy/sub-processors', { method: 'POST', body: input });
}

export function deleteSubProcessor(id: string): Promise<{ deleted: true }> {
  return apiFetch(`/platform/privacy/sub-processors/${id}`, { method: 'DELETE' });
}

export function residencyOverview(): Promise<ResidencyOverviewRow[]> {
  return apiFetch('/platform/privacy/residency-overview');
}

export function listCrossTenantRequests(params: { tenantId?: string; status?: string } = {}): Promise<DataSubjectRequestSummary[]> {
  return apiFetch('/platform/privacy/requests', { query: params });
}

export function runRetentionSweepNow(): Promise<Record<string, number>> {
  return apiFetch('/platform/privacy/retention-sweep/run', { method: 'POST' });
}
