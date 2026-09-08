import { apiFetch, apiFetchBlob } from './client';
import { triggerBrowserDownload } from '../download';
import type { ColumnMappingTemplate, ImportBatch, ImportRowError } from './types';

export interface CreateImportBatchInput {
  entityType: string;
  fileFormat: 'CSV' | 'XLSX';
  mode?: 'PARTIAL' | 'ALL_OR_NOTHING';
  columnMapping: Record<string, string>;
  columnMappingTemplateId?: string;
  file: File;
}

export function createImportBatch(input: CreateImportBatchInput): Promise<ImportBatch> {
  const form = new FormData();
  form.append('entityType', input.entityType);
  form.append('fileFormat', input.fileFormat);
  form.append('mode', input.mode ?? 'PARTIAL');
  form.append('columnMapping', JSON.stringify(input.columnMapping));
  if (input.columnMappingTemplateId) form.append('columnMappingTemplateId', input.columnMappingTemplateId);
  form.append('file', input.file);
  return apiFetch<ImportBatch>('/migration/batches', { method: 'POST', body: form });
}

export function listImportBatches(params: { entityType?: string; status?: string } = {}): Promise<ImportBatch[]> {
  return apiFetch<ImportBatch[]>('/migration/batches', { query: params });
}

export function getImportBatch(id: string): Promise<ImportBatch> {
  return apiFetch<ImportBatch>(`/migration/batches/${id}`);
}

export function validateImportBatch(id: string): Promise<ImportBatch> {
  return apiFetch<ImportBatch>(`/migration/batches/${id}/validate`, { method: 'POST' });
}

export function commitImportBatch(id: string): Promise<ImportBatch> {
  return apiFetch<ImportBatch>(`/migration/batches/${id}/commit`, { method: 'POST' });
}

export function listImportRowErrors(id: string, phase?: 'DRY_RUN' | 'COMMIT'): Promise<ImportRowError[]> {
  return apiFetch<ImportRowError[]>(`/migration/batches/${id}/errors`, { query: { phase } });
}

export async function downloadImportErrorReport(id: string): Promise<void> {
  const { blob, filename } = await apiFetchBlob(`/migration/batches/${id}/report`);
  triggerBrowserDownload(blob, filename ?? `import-${id}-errors.csv`);
}

export interface SaveColumnMappingTemplateInput {
  name: string;
  entityType: string;
  mapping: Record<string, string>;
}

export function saveColumnMappingTemplate(input: SaveColumnMappingTemplateInput): Promise<ColumnMappingTemplate> {
  return apiFetch<ColumnMappingTemplate>('/migration/mapping-templates', { method: 'POST', body: input });
}

export function listColumnMappingTemplates(entityType?: string): Promise<ColumnMappingTemplate[]> {
  return apiFetch<ColumnMappingTemplate[]>('/migration/mapping-templates', { query: { entityType } });
}

export function removeColumnMappingTemplate(id: string): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/migration/mapping-templates/${id}`, { method: 'DELETE' });
}
