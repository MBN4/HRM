import { apiFetch, apiFetchBlob } from './client';
import { triggerBrowserDownload } from '../download';

export interface StatutoryReportDefinition {
  id: string;
  countryCode: string;
  reportCode: string;
  name: string;
  description: string;
  periodType: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  outputFormats: string[];
  complianceNote: string;
}

export interface GeneratedReportSummary {
  employeeCount: number;
  totals: Record<string, number>;
}

export interface GeneratedReport {
  id: string;
  branchId: string;
  reportDefinitionId: string;
  reportCode: string;
  countryCode: string;
  periodType: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  periodYear: number;
  periodMonth: number | null;
  periodQuarter: number | null;
  periodKey: string;
  status: 'PENDING' | 'GENERATING' | 'COMPLETED' | 'FAILED';
  summary?: GeneratedReportSummary;
  errorMessage: string | null;
  generatedAt: string | null;
  createdAt: string;
}

export function listStatutoryReportDefinitions(branchId: string): Promise<StatutoryReportDefinition[]> {
  return apiFetch<StatutoryReportDefinition[]>('/statutory-reports/definitions', { query: { branchId } });
}

export interface GenerateStatutoryReportInput {
  branchId: string;
  reportCode: string;
  periodYear: number;
  periodMonth?: number;
  periodQuarter?: number;
}

export function generateStatutoryReport(input: GenerateStatutoryReportInput): Promise<GeneratedReport> {
  return apiFetch<GeneratedReport>('/statutory-reports/generate', { method: 'POST', body: input });
}

export function listGeneratedReports(params: { branchId?: string; reportCode?: string; periodYear?: number } = {}): Promise<GeneratedReport[]> {
  return apiFetch<GeneratedReport[]>('/statutory-reports', { query: params });
}

export function getGeneratedReport(id: string): Promise<GeneratedReport> {
  return apiFetch<GeneratedReport>(`/statutory-reports/${id}`);
}

/** Fetches a generated report file and immediately triggers a browser download — see `apiFetchBlob`/`triggerBrowserDownload`. */
export async function downloadGeneratedReport(id: string, format: 'pdf' | 'csv', fallbackFilename: string): Promise<void> {
  const { blob, filename } = await apiFetchBlob(`/statutory-reports/${id}/download`, { query: { format } });
  triggerBrowserDownload(blob, filename ?? fallbackFilename);
}
