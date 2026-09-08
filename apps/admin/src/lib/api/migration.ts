import { apiFetch, apiFetchBlob } from './client';
import { triggerBrowserDownload } from '../download';
import type { ImportBatch, ImportRowError } from './types';

export interface CreatePlatformImportBatchInput {
  entityType: string;
  fileFormat: 'CSV' | 'XLSX';
  mode?: 'PARTIAL' | 'ALL_OR_NOTHING';
  columnMapping: Record<string, string>;
  file: File;
}

export function createPlatformImportBatch(tenantId: string, input: CreatePlatformImportBatchInput): Promise<ImportBatch> {
  const form = new FormData();
  form.append('entityType', input.entityType);
  form.append('fileFormat', input.fileFormat);
  form.append('mode', input.mode ?? 'PARTIAL');
  form.append('columnMapping', JSON.stringify(input.columnMapping));
  form.append('file', input.file);
  return apiFetch<ImportBatch>(`/platform/tenants/${tenantId}/migration/batches`, { method: 'POST', body: form });
}

export function listPlatformImportBatches(tenantId: string): Promise<ImportBatch[]> {
  return apiFetch<ImportBatch[]>(`/platform/tenants/${tenantId}/migration/batches`);
}

export function getPlatformImportBatch(tenantId: string, id: string): Promise<ImportBatch> {
  return apiFetch<ImportBatch>(`/platform/tenants/${tenantId}/migration/batches/${id}`);
}

export function validatePlatformImportBatch(tenantId: string, id: string): Promise<ImportBatch> {
  return apiFetch<ImportBatch>(`/platform/tenants/${tenantId}/migration/batches/${id}/validate`, { method: 'POST' });
}

export function commitPlatformImportBatch(tenantId: string, id: string): Promise<ImportBatch> {
  return apiFetch<ImportBatch>(`/platform/tenants/${tenantId}/migration/batches/${id}/commit`, { method: 'POST' });
}

export function listPlatformImportRowErrors(tenantId: string, id: string): Promise<ImportRowError[]> {
  return apiFetch<ImportRowError[]>(`/platform/tenants/${tenantId}/migration/batches/${id}/errors`);
}

export async function downloadPlatformImportErrorReport(tenantId: string, id: string): Promise<void> {
  const { blob, filename } = await apiFetchBlob(`/platform/tenants/${tenantId}/migration/batches/${id}/report`);
  triggerBrowserDownload(blob, filename ?? `import-${id}-errors.csv`);
}
