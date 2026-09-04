import { apiFetch } from './client';
import type { BrandingDomain, PlatformBrandingSummary } from './types';

export function listBrandings(): Promise<PlatformBrandingSummary[]> {
  return apiFetch('/platform/branding/tenants');
}

export function getTenantDomain(tenantId: string): Promise<BrandingDomain | null> {
  return apiFetch(`/platform/branding/tenants/${tenantId}/domain`);
}

export function verifyDomain(tenantId: string, domainId: string): Promise<BrandingDomain> {
  return apiFetch(`/platform/branding/tenants/${tenantId}/domain/${domainId}/verify`, { method: 'POST' });
}

export function approveDomain(tenantId: string, domainId: string): Promise<BrandingDomain> {
  return apiFetch(`/platform/branding/tenants/${tenantId}/domain/${domainId}/approve`, { method: 'POST' });
}

export function provisionTls(tenantId: string, domainId: string): Promise<BrandingDomain> {
  return apiFetch(`/platform/branding/tenants/${tenantId}/domain/${domainId}/provision-tls`, { method: 'POST' });
}

export function resetTenantBranding(tenantId: string): Promise<void> {
  return apiFetch(`/platform/branding/tenants/${tenantId}/reset`, { method: 'DELETE' });
}
