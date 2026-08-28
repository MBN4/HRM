import { apiFetch } from './client';
import type { NotificationItem } from './types';

export function listNotifications(): Promise<NotificationItem[]> {
  return apiFetch<NotificationItem[]>('/notifications');
}

export function markNotificationRead(deliveryId: string): Promise<unknown> {
  return apiFetch(`/notifications/${deliveryId}/read`, { method: 'POST' });
}
