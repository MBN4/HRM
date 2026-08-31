import { apiFetch } from './client';
import type { AnalyticsDashboard } from './types';

export type AnalyticsDashboardFilters = { branchId?: string; departmentId?: string; from?: string; to?: string };

export function getAnalyticsDashboard(filters: AnalyticsDashboardFilters = {}): Promise<AnalyticsDashboard> {
  return apiFetch<AnalyticsDashboard>('/analytics/dashboard', { query: filters });
}

export function runAnalyticsRollup(date?: string): Promise<{ enqueued: boolean }> {
  return apiFetch<{ enqueued: boolean }>('/analytics/rollup/run', { method: 'POST', body: { date } });
}
