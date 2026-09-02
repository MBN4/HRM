import { apiFetch } from './client';
import type { Asset, AssetAssignment, AssetCategory, AssetMaintenanceRecord } from './types';

export interface CreateAssetCategoryInput {
  code: string;
  name: string;
}

export function upsertAssetCategory(input: CreateAssetCategoryInput): Promise<AssetCategory> {
  return apiFetch<AssetCategory>('/assets/categories', { method: 'POST', body: input });
}

export function listAssetCategories(): Promise<AssetCategory[]> {
  return apiFetch<AssetCategory[]>('/assets/categories');
}

export interface RegisterAssetInput {
  categoryId: string;
  branchId?: string;
  assetTag: string;
  name: string;
  serialNumber?: string;
  purchaseDate?: string;
  purchaseCost?: number;
}

export function registerAsset(input: RegisterAssetInput): Promise<Asset> {
  return apiFetch<Asset>('/assets', { method: 'POST', body: input });
}

export function listAssets(params: { status?: string; categoryId?: string; branchId?: string } = {}): Promise<Asset[]> {
  return apiFetch<Asset[]>('/assets', { query: params });
}

export function getAsset(id: string): Promise<Asset> {
  return apiFetch<Asset>(`/assets/${id}`);
}

export function assignAsset(input: { assetId: string; employeeId: string; condition?: string; notes?: string }): Promise<AssetAssignment> {
  return apiFetch<AssetAssignment>('/assets/assign', { method: 'POST', body: input });
}

export function returnAsset(assignmentId: string, input: { returnCondition?: string; notes?: string } = {}): Promise<AssetAssignment> {
  return apiFetch<AssetAssignment>(`/assets/assignments/${assignmentId}/return`, { method: 'POST', body: input });
}

export function listMyAssignments(): Promise<AssetAssignment[]> {
  return apiFetch<AssetAssignment[]>('/assets/my');
}

export function listAssignmentsForEmployee(employeeId: string): Promise<AssetAssignment[]> {
  return apiFetch<AssetAssignment[]>(`/assets/employees/${employeeId}/assignments`);
}

export function listAssignmentsForAsset(assetId: string): Promise<AssetAssignment[]> {
  return apiFetch<AssetAssignment[]>(`/assets/${assetId}/assignments`);
}

export function createMaintenanceRecord(input: { assetId: string; description: string; startedAt?: string; cost?: number }): Promise<AssetMaintenanceRecord> {
  return apiFetch<AssetMaintenanceRecord>('/assets/maintenance', { method: 'POST', body: input });
}

export function completeMaintenanceRecord(id: string, cost?: number): Promise<AssetMaintenanceRecord> {
  return apiFetch<AssetMaintenanceRecord>(`/assets/maintenance/${id}/complete`, { method: 'POST', body: { cost } });
}

export function listMaintenanceForAsset(assetId: string): Promise<AssetMaintenanceRecord[]> {
  return apiFetch<AssetMaintenanceRecord[]>(`/assets/${assetId}/maintenance`);
}
