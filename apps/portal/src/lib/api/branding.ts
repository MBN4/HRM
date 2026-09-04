import { apiFetch, apiFetchBlob } from './client';
import type { BrandingDomain, BrandingSettings, PublicBranding } from './types';

/** `@AllowAnonymous()` on the backend — safe to call before login (the login screen itself uses this). `skipAuth: true` so an unresolved tenant (e.g. a fresh header-strategy visitor with no slug captured yet) never triggers the 401-refresh-then-redirect dance `apiFetch` otherwise does. */
export function getPublicBranding(): Promise<PublicBranding> {
  return apiFetch<PublicBranding>('/branding', { skipAuth: true });
}

export function getBrandingSettings(): Promise<BrandingSettings> {
  return apiFetch<BrandingSettings>('/branding/settings');
}

export interface UpdateBrandingInput {
  productName?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  loginHeadline?: string | null;
  loginSubtext?: string | null;
  emailFromName?: string | null;
  emailFromAddress?: string | null;
}

export function updateBranding(input: UpdateBrandingInput): Promise<void> {
  return apiFetch('/branding', { method: 'PUT', body: input });
}

export function updateFullRebrand(enabled: boolean): Promise<void> {
  return apiFetch('/branding/rebrand', { method: 'PUT', body: { enabled } });
}

export async function uploadBrandingLogo(file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  await apiFetch('/branding/logo', { method: 'POST', body: form });
}

export async function uploadBrandingFavicon(file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  await apiFetch('/branding/favicon', { method: 'POST', body: form });
}

/** Only called after a successful `getPublicBranding()` already confirmed the tenant resolves and `hasLogo`/`hasFavicon` is true — `apiFetchBlob` has no `skipAuth` option, so this relies on the tenant already being resolvable by the time it runs. */
export async function fetchBrandingImage(path: '/branding/logo' | '/branding/favicon'): Promise<string> {
  const { blob } = await apiFetchBlob(path);
  return URL.createObjectURL(blob);
}

export function requestBrandingDomain(domain: string): Promise<BrandingDomain> {
  return apiFetch<BrandingDomain>('/branding/domain', { method: 'POST', body: { domain } });
}

export function deleteBrandingDomain(id: string): Promise<void> {
  return apiFetch(`/branding/domain/${id}`, { method: 'DELETE' });
}
