import * as SecureStore from 'expo-secure-store';
import { TENANT_HEADER } from '../constants/app';

/**
 * Mobile ALWAYS uses tenant-resolution strategy #3 ("header") — see
 * docs/conventions/tenant-resolution.md: "`TENANT_HEADER_NAME` (default
 * `x-tenant-id`) carrying either the tenant's UUID `id` or its `slug`, for
 * mobile/API clients with no per-tenant hostname." Unlike apps/portal
 * (which prefers the subdomain strategy when served from a tenant
 * subdomain and only falls back to the header for local dev, see
 * apps/portal/src/lib/tenant.ts), a native app has no concept of "the host
 * it's being served from" at all — there is exactly one strategy here,
 * always.
 */
const TENANT_SLUG_KEY = 'hrm.tenantSlug';

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

let cachedTenantSlug: string | null = null;

export async function getStoredTenantSlug(): Promise<string | null> {
  if (cachedTenantSlug !== null) return cachedTenantSlug;
  try {
    const value = await SecureStore.getItemAsync(TENANT_SLUG_KEY);
    cachedTenantSlug = value;
    return value;
  } catch {
    return null;
  }
}

export async function setStoredTenantSlug(slug: string): Promise<void> {
  cachedTenantSlug = slug;
  try {
    await SecureStore.setItemAsync(TENANT_SLUG_KEY, slug);
  } catch {
    // Storage unavailable — the session still works for this app run via
    // the in-memory cache; a cold restart will require re-entering it.
  }
}

export async function clearStoredTenantSlug(): Promise<void> {
  cachedTenantSlug = null;
  try {
    await SecureStore.deleteItemAsync(TENANT_SLUG_KEY);
  } catch {
    // Nothing more to do.
  }
}

export { TENANT_HEADER };
