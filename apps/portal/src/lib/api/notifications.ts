import { apiFetch } from './client';
import type { NotificationItem, NotificationPreference } from './types';

export function listNotifications(): Promise<NotificationItem[]> {
  return apiFetch<NotificationItem[]>('/notifications');
}

export function markNotificationRead(deliveryId: string) {
  return apiFetch(`/notifications/${deliveryId}/read`, { method: 'POST' });
}

export function getNotificationPreferences(): Promise<NotificationPreference[]> {
  return apiFetch<NotificationPreference[]>('/notifications/preferences');
}

export function updateNotificationPreferences(preferences: NotificationPreference[]): Promise<NotificationPreference[]> {
  return apiFetch<NotificationPreference[]>('/notifications/preferences', { method: 'PUT', body: { preferences } });
}
