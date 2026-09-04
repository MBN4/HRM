import { apiFetch } from './client';
import type { PublicBranding } from './types';

/** `@AllowAnonymous()` on the backend — safe to call before login (the login screen itself uses this). `skipAuth: true` so an unresolvable tenant (no stored slug captured yet, on a genuinely fresh install) fails silently into the plain defaults rather than triggering any auth-recovery flow. */
export function getPublicBranding(): Promise<PublicBranding> {
  return apiFetch<PublicBranding>('/branding', { skipAuth: true });
}
