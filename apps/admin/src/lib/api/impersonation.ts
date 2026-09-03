import { apiFetch } from './client';
import type { ImpersonationSessionDto } from './types';

export function startImpersonation(
  tenantId: string,
  targetUserId: string,
  reason: string,
  durationMinutes?: number,
): Promise<{ session: ImpersonationSessionDto; accessToken: string }> {
  return apiFetch(`/platform/impersonation/tenants/${tenantId}/sessions`, {
    method: 'POST',
    body: { targetUserId, reason, durationMinutes },
  });
}

export function listImpersonationSessions(filters: {
  tenantId?: string;
  platformAdminId?: string;
  activeOnly?: boolean;
}): Promise<ImpersonationSessionDto[]> {
  return apiFetch('/platform/impersonation/sessions', { query: filters });
}

export function endImpersonation(sessionId: string): Promise<ImpersonationSessionDto> {
  return apiFetch(`/platform/impersonation/sessions/${sessionId}/end`, { method: 'POST' });
}

export function revokeImpersonation(sessionId: string): Promise<ImpersonationSessionDto> {
  return apiFetch(`/platform/impersonation/sessions/${sessionId}/revoke`, { method: 'POST' });
}
