import { apiFetch } from './client';

/**
 * The typed client for `GET /attendance/status` (step 8.1 Part 2) — see
 * docs/conventions/attendance-status.md. Part 3 (the live clock + monthly
 * graph, docs/conventions/attendance-ui.md) is the only consumer: it never
 * reimplements the classification rules, it just renders this response.
 */
export const DAY_STATUSES = ['GREEN', 'YELLOW', 'RED', 'NEUTRAL', 'IN_PROGRESS'] as const;
export type AttendanceDayStatus = (typeof DAY_STATUSES)[number];

export const DAY_REASONS = [
  'ON_TIME',
  'WITHIN_GRACE',
  'LATE_BEYOND_GRACE',
  'HALF_DAY',
  'EARLY_OUT',
  'SHORT_DAY',
  'MISSING_CLOCK_OUT',
  'ABSENT',
  'WEEKEND',
  'HOLIDAY',
  'ON_LEAVE',
  'NOT_EMPLOYED',
  'FUTURE',
  'NOT_CLOCKED_IN',
  'CLOCKED_IN',
] as const;
export type AttendanceDayReason = (typeof DAY_REASONS)[number];

export type AttendanceStatusPolicySource = 'MEMBER' | 'TEAM' | 'COMPANY' | 'COUNTRY_PACK';

export interface ClassifiedAttendanceDay {
  date: string;
  status: AttendanceDayStatus;
  reason: AttendanceDayReason;
  reasons: AttendanceDayReason[];
  isLate: boolean;
  minutesLate: number;
  isEarlyOut: boolean;
  minutesEarly: number;
  isShortDay: boolean;
  isHalfDay: boolean;
  hoursWorked: number;
  requiredHours: number;
  clockIn: string | null;
  clockOut: string | null;
  policySource: AttendanceStatusPolicySource;
}

export interface AttendanceStatusResponse {
  employeeId: string;
  from: string;
  to: string;
  timezone: string;
  policy: {
    startTime: string;
    workHours: number;
    breakHours: number;
    requiredHours: number;
    graceMinutes: number;
    halfDayThresholdHours: number;
    source: AttendanceStatusPolicySource;
  };
  days: ClassifiedAttendanceDay[];
  summary: Record<AttendanceDayStatus, number>;
}

export function getAttendanceStatus(params: { employeeId?: string; from: string; to: string }): Promise<AttendanceStatusResponse> {
  return apiFetch<AttendanceStatusResponse>('/attendance/status', { query: params });
}
