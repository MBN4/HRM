import { apiFetch } from './client';
import type { PlatformAdminStatus, PlatformAdminSummary, PlatformRole } from './types';

export function listPlatformAdmins(): Promise<PlatformAdminSummary[]> {
  return apiFetch('/platform/admins');
}

export function createPlatformAdmin(input: {
  email: string;
  name: string;
  password: string;
  role: PlatformRole;
}): Promise<PlatformAdminSummary> {
  return apiFetch('/platform/admins', { method: 'POST', body: input });
}

export function updatePlatformAdmin(
  id: string,
  input: Partial<{ role: PlatformRole; status: PlatformAdminStatus }>,
): Promise<PlatformAdminSummary> {
  return apiFetch(`/platform/admins/${id}`, { method: 'PATCH', body: input });
}
