import { TENANT_HEADER } from '@hrm/shared';

/**
 * Where the portal decides HOW a browser request reaches the right tenant —
 * see docs/conventions/frontend-ess-mss.md for the full write-up. Mirrors
 * 0.3's subdomain strategy when the portal itself is served from a tenant
 * subdomain (production shape); falls back to 0.3's header strategy
 * (`x-tenant-id`, the SAME constant/mechanism native/API clients use) for
 * plain "localhost" local dev, using a slug captured once at login.
 */
const FALLBACK_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const API_BASE_DOMAIN = process.env.NEXT_PUBLIC_TENANT_BASE_DOMAIN;
const API_PORT = process.env.NEXT_PUBLIC_API_PORT ?? '3001';
const TENANT_SLUG_STORAGE_KEY = 'hrm.tenantSlug';

export interface TenantResolution {
  apiBaseUrl: string;
  /** Set only when falling back to the header strategy (no usable subdomain). */
  headerTenantId: string | null;
}

export function resolveTenant(): TenantResolution {
  if (typeof window === 'undefined') {
    return { apiBaseUrl: FALLBACK_API_URL, headerTenantId: null };
  }
  const host = window.location.hostname;
  if (API_BASE_DOMAIN && host !== API_BASE_DOMAIN && host.endsWith(`.${API_BASE_DOMAIN}`)) {
    const subdomain = host.slice(0, host.length - API_BASE_DOMAIN.length - 1);
    return {
      apiBaseUrl: `${window.location.protocol}//${subdomain}.${API_BASE_DOMAIN}:${API_PORT}`,
      headerTenantId: null,
    };
  }
  return { apiBaseUrl: FALLBACK_API_URL, headerTenantId: getStoredTenantSlug() };
}

export function getStoredTenantSlug(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TENANT_SLUG_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredTenantSlug(slug: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TENANT_SLUG_STORAGE_KEY, slug);
  } catch {
    // Storage unavailable (private browsing, quota) — the header strategy
    // simply won't have a slug to send; the login form still lets the user
    // retype it next time.
  }
}

/** Whether the CURRENT host already carries a real tenant subdomain — the login form only needs its "Workspace" field when this is false. */
export function isUsingSubdomainResolution(): boolean {
  if (typeof window === 'undefined' || !API_BASE_DOMAIN) return false;
  const host = window.location.hostname;
  return host !== API_BASE_DOMAIN && host.endsWith(`.${API_BASE_DOMAIN}`);
}

export { TENANT_HEADER };
