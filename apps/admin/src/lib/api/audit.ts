import { apiFetch } from './client';
import type { PlatformAuditLogEntry, TenantAuditLogEntry } from './types';

export function listPlatformAuditLog(filters: {
  targetTenantId?: string;
  platformAdminId?: string;
  action?: string;
  entityType?: string;
  before?: string;
}): Promise<PlatformAuditLogEntry[]> {
  return apiFetch('/platform/audit', { query: filters });
}

export function listTenantAuditLog(
  tenantId: string,
  filters: { entityType?: string; entityId?: string; action?: string; before?: string } = {},
): Promise<TenantAuditLogEntry[]> {
  return apiFetch(`/platform/audit/tenant/${tenantId}`, { query: filters });
}
