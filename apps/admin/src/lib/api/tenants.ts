import { apiFetch } from './client';
import type { ProvisionMode, TenantEdition, TenantSummary, TenantUserOption } from './types';

export function listTenants(): Promise<TenantSummary[]> {
  return apiFetch('/platform/tenants');
}

export function getTenant(id: string): Promise<TenantSummary> {
  return apiFetch(`/platform/tenants/${id}`);
}

export function listTenantUsers(id: string): Promise<TenantUserOption[]> {
  return apiFetch(`/platform/tenants/${id}/users`);
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  defaultCountryCode: string;
  hostingRegion: string;
  edition?: TenantEdition;
  provisionMode?: ProvisionMode;
  baseCurrencyCode?: string;
  initialAdminEmail?: string;
  initialAdminName?: string;
  initialAdminPassword?: string;
}

export function createTenant(input: CreateTenantInput): Promise<TenantSummary> {
  return apiFetch('/platform/tenants', { method: 'POST', body: input });
}

export function updateTenant(
  id: string,
  input: Partial<{ edition: TenantEdition; hostingRegion: string; provisionMode: ProvisionMode }>,
): Promise<TenantSummary> {
  return apiFetch(`/platform/tenants/${id}`, { method: 'PATCH', body: input });
}

export function suspendTenant(id: string, reason?: string): Promise<TenantSummary> {
  return apiFetch(`/platform/tenants/${id}/suspend`, { method: 'POST', body: { reason } });
}

export function resumeTenant(id: string): Promise<TenantSummary> {
  return apiFetch(`/platform/tenants/${id}/resume`, { method: 'POST' });
}

export function deleteTenant(id: string, confirmSlug: string): Promise<void> {
  return apiFetch(`/platform/tenants/${id}`, { method: 'DELETE', body: { confirmSlug } });
}
