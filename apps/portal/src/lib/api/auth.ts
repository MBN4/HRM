import { apiFetch } from './client';
import { clearTokens, getRefreshToken, setTokens } from '../auth/token-storage';
import type { LoginResponse, MeResponse } from './types';

export function apiLogin(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/auth/login', { method: 'POST', body: { email, password }, skipAuth: true });
}

/** Runs once on app load: exchanges a persisted refresh token for a fresh access token. Returns whether it succeeded. */
export async function bootstrapSession(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const data = await apiFetch<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
      skipAuth: true,
    });
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

export function apiMe(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/auth/me');
}

export async function apiLogout(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return;
  await apiFetch('/auth/logout', { method: 'POST', body: { refreshToken } });
}

export function apiLogoutAll(): Promise<void> {
  return apiFetch('/auth/logout-all', { method: 'POST' });
}

export function apiChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  return apiFetch('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
}

/**
 * Always resolves — the API responds `204` unconditionally (whether or not
 * the account exists) to avoid user enumeration; see
 * docs/conventions/auth-rbac.md and docs/conventions/frontend-ess-mss.md →
 * "Forgot / reset password".
 */
export function apiRequestPasswordReset(email: string): Promise<void> {
  return apiFetch('/auth/request-password-reset', { method: 'POST', body: { email }, skipAuth: true });
}

export function apiResetPassword(token: string, newPassword: string): Promise<void> {
  return apiFetch('/auth/reset-password', { method: 'POST', body: { token, newPassword }, skipAuth: true });
}
