import { apiFetch } from './client';

/** Kiosk administration (step 11.1) — mirrors `/kiosks/*` (JWT + `kiosk.manage`). The device-facing calls live in `lib/kiosk/device.ts`. */
export interface Kiosk {
  id: string;
  branchId: string;
  branchName: string;
  name: string;
  tokenPrefix: string;
  status: 'ACTIVE' | 'REVOKED';
  requirePhoto: boolean;
  biometricEnabled: boolean;
  tokenIssuedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  online: boolean;
}

/** The ONLY responses that carry the raw device token — shown once. */
export type KioskWithToken = Kiosk & { token: string };

export interface KioskActivity {
  recordId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  workDate: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  hasPhoto: boolean;
}

export interface KioskPinRow {
  employeeId: string;
  employeeCode: string;
  name: string;
  branchId: string;
  hasPin: boolean;
  issuedAt: string | null;
  lastUsedAt: string | null;
  locked: boolean;
}

export interface IssuedKioskPin {
  id: string;
  employeeCode: string;
  name: string;
  /** Shown once. */
  pin: string;
}

export const listKiosks = () => apiFetch<Kiosk[]>('/kiosks');
export const registerKiosk = (input: {
  name: string;
  branchId: string;
  requirePhoto: boolean;
  biometricEnabled: boolean;
}) => apiFetch<KioskWithToken>('/kiosks', { method: 'POST', body: input });
export const updateKiosk = (
  id: string,
  input: { name?: string; requirePhoto?: boolean; biometricEnabled?: boolean },
) => apiFetch<Kiosk>(`/kiosks/${id}`, { method: 'PATCH', body: input });
export const rotateKioskToken = (id: string) =>
  apiFetch<KioskWithToken>(`/kiosks/${id}/token`, { method: 'POST' });
export const revokeKiosk = (id: string) => apiFetch<Kiosk>(`/kiosks/${id}`, { method: 'DELETE' });
export const getKioskActivity = (id: string) => apiFetch<KioskActivity[]>(`/kiosks/${id}/activity`);

export const listKioskPins = (query: { branchId?: string; search?: string; limit?: number }) =>
  apiFetch<KioskPinRow[]>('/kiosks/pins', { query });
export const issueKioskPin = (employeeId: string) =>
  apiFetch<IssuedKioskPin>(`/kiosks/pins/${employeeId}`, { method: 'POST' });
export const removeKioskPin = (employeeId: string) =>
  apiFetch<{ id: string; removed: boolean }>(`/kiosks/pins/${employeeId}`, { method: 'DELETE' });

/** The URL that opens the kiosk screen already paired — the token rides in the FRAGMENT, so it never reaches a server or access log. */
export function kioskLaunchUrl(token: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/kiosk#token=${encodeURIComponent(token)}`;
}
