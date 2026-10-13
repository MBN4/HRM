import { apiFetch } from './client';

/** Mirrors `GET /scheduling/my-schedule` (step 8.2; apps/api/src/scheduling/my-schedule.service.ts) — read-only on mobile. */
export type ScheduleDayKind = 'SHIFT' | 'DAY_OFF' | 'DEFAULT_HOURS' | 'WEEKEND' | 'HOLIDAY' | 'LEAVE';

export interface MyScheduleDay {
  date: string;
  kind: ScheduleDayKind;
  via: 'ROSTER' | 'STANDING' | null;
  shift: { id: string; name: string; startTime: string; endTime: string; crossesMidnight: boolean; color: string | null } | null;
  startTime: string | null;
  requiredHours: number | null;
  swap: { id: string; status: 'AWAITING_PEER' | 'PENDING_APPROVAL'; mine: boolean } | null;
}

export interface MySchedule {
  employeeId: string;
  timezone: string;
  today: string;
  from: string;
  to: string;
  days: MyScheduleDay[];
}

export function getMySchedule(params: { from?: string; to?: string } = {}): Promise<MySchedule> {
  return apiFetch<MySchedule>('/scheduling/my-schedule', { query: params });
}
