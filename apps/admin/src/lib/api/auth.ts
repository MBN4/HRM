import { apiFetch } from './client';
import type { PlatformEnrollmentSecret, PlatformLoginStepResult, PlatformMe, PlatformSession } from './types';

export function platformLogin(email: string, password: string): Promise<PlatformLoginStepResult> {
  return apiFetch('/platform/auth/login', { method: 'POST', body: { email, password }, skipAuth: true });
}

export function platformStartMfaEnrollment(enrollmentToken: string): Promise<PlatformEnrollmentSecret> {
  return apiFetch('/platform/auth/mfa/enroll', { method: 'POST', body: { enrollmentToken }, skipAuth: true });
}

export function platformConfirmMfaEnrollment(
  enrollmentToken: string,
  code: string,
): Promise<PlatformSession & { recoveryCodes: string[] }> {
  return apiFetch('/platform/auth/mfa/enroll/confirm', { method: 'POST', body: { enrollmentToken, code }, skipAuth: true });
}

export function platformVerifyMfa(challengeToken: string, code: string): Promise<PlatformSession> {
  return apiFetch('/platform/auth/mfa/verify', { method: 'POST', body: { challengeToken, code }, skipAuth: true });
}

export function platformLogout(refreshToken: string): Promise<void> {
  return apiFetch('/platform/auth/logout', { method: 'POST', body: { refreshToken } });
}

export function platformMe(): Promise<PlatformMe> {
  return apiFetch('/platform/auth/me');
}
