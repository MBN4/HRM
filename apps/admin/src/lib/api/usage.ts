import { apiFetch } from './client';
import type { PlatformOverview, TenantUsageMetrics } from './types';

export function getUsageOverview(): Promise<PlatformOverview> {
  return apiFetch('/platform/usage/overview');
}

export function getTenantUsage(tenantId: string): Promise<TenantUsageMetrics> {
  return apiFetch(`/platform/usage/${tenantId}`);
}
