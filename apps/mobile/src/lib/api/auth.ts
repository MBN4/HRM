import { apiFetch } from './client';
import { clearTokens, getRefreshToken, setTokens } from '../auth/tokenStorage';
import type { LoginResponse, MeResponse } from './types';

export function apiLogin(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/auth/login', { method: 'POST', body: { email, password }, skipAuth: true });
}

/** Runs once on app cold start: exchanges a persisted refresh token for a fresh access token. Returns whether it succeeded. */
export async function bootstrapSession(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return false;
  try {
    const data = await apiFetch<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
      skipAuth: true,
    });
    await setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    await clearTokens();
    return false;
  }
}

export function apiMe(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/auth/me');
}

export async function apiLogout(): Promise<void> {
  const refreshToken = await getRefreshToken();
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
 * `POST /auth/push-token` — the new, minimal route added this same step
 * specifically for mobile ESS (see apps/api/src/auth/auth.controller.ts +
 * `setPushTokenSchema` in @hrm/shared/src/validators/auth.validator.ts).
 * Registers (or, with `null`, deregisters on logout) the caller's own
 * device's Expo push token against `User.pushToken`, which
 * `apps/api/src/notifications/notification-delivery.service.ts`'s PUSH
 * channel dispatch already reads as the real `to` address — see
 * src/lib/push.ts for the client-side registration flow this feeds.
 */
export function apiSetPushToken(pushToken: string | null): Promise<void> {
  return apiFetch('/auth/push-token', { method: 'POST', body: { pushToken } });
}
