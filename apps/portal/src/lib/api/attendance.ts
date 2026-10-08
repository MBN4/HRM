import { apiFetch } from './client';
import type { AttendanceDailySummary, AttendanceRecord, AttendanceRegularization, AttendanceSource } from './types';

export interface ClockInOutInput {
  employeeId?: string;
  source?: Extract<AttendanceSource, 'WEB' | 'MOBILE'>;
  lat?: number;
  long?: number;
  photo?: File | null;
}

function toFormData(input: ClockInOutInput): FormData {
  const form = new FormData();
  if (input.employeeId) form.set('employeeId', input.employeeId);
  form.set('source', input.source ?? 'WEB');
  if (input.lat !== undefined) form.set('lat', String(input.lat));
  if (input.long !== undefined) form.set('long', String(input.long));
  if (input.photo) form.set('photo', input.photo);
  return form;
}

export function clockIn(input: ClockInOutInput): Promise<AttendanceRecord> {
  return apiFetch<AttendanceRecord>('/attendance/clock-in', { method: 'POST', body: toFormData(input) });
}

export function clockOut(input: ClockInOutInput): Promise<AttendanceRecord> {
  return apiFetch<AttendanceRecord>('/attendance/clock-out', { method: 'POST', body: toFormData(input) });
}

export function listAttendanceRecords(params: { employeeId?: string; branchId?: string; from?: string; to?: string } = {}): Promise<AttendanceRecord[]> {
  return apiFetch<AttendanceRecord[]>('/attendance/records', { query: params });
}

export function getAttendanceRecord(id: string): Promise<AttendanceRecord> {
  return apiFetch<AttendanceRecord>(`/attendance/records/${id}`);
}

export interface SubmitRegularizationInput {
  employeeId?: string;
  attendanceRecordId?: string;
  workDate: string;
  requestedClockInAt?: string;
  requestedClockOutAt?: string;
  reason: string;
}

export function submitRegularization(input: SubmitRegularizationInput): Promise<AttendanceRegularization> {
  return apiFetch<AttendanceRegularization>('/attendance/regularizations', { method: 'POST', body: input });
}

export function listRegularizations(params: { employeeId?: string; status?: string } = {}): Promise<AttendanceRegularization[]> {
  return apiFetch<AttendanceRegularization[]>('/attendance/regularizations', { query: params });
}

export function getRegularization(id: string): Promise<AttendanceRegularization> {
  return apiFetch<AttendanceRegularization>(`/attendance/regularizations/${id}`);
}

export function getAttendanceSummaryReport(params: { employeeId?: string; branchId?: string; from?: string; to?: string } = {}): Promise<AttendanceDailySummary[]> {
  return apiFetch<AttendanceDailySummary[]>('/attendance/reports/summary', { query: params });
}

export function runAttendanceSummary(input: { workDate: string; branchId?: string; employeeId?: string }): Promise<{ enqueued: boolean }> {
  return apiFetch('/attendance/summary/run', { method: 'POST', body: input });
}

// ---- Step 8.1 Part 3: day-status classification (GET /attendance/status — Part 2, consumed as-is) ----

export type DayStatus = 'GREEN' | 'YELLOW' | 'RED' | 'NEUTRAL' | 'IN_PROGRESS';
export type DayReason =
  | 'ON_TIME'
  | 'WITHIN_GRACE'
  | 'LATE_BEYOND_GRACE'
  | 'HALF_DAY'
  | 'EARLY_OUT'
  | 'SHORT_DAY'
  | 'MISSING_CLOCK_OUT'
  | 'ABSENT'
  | 'WEEKEND'
  | 'HOLIDAY'
  | 'ON_LEAVE'
  | 'NOT_EMPLOYED'
  | 'FUTURE'
  | 'NOT_CLOCKED_IN'
  | 'CLOCKED_IN';

export interface ClassifiedDay {
  date: string;
  status: DayStatus;
  reason: DayReason;
  reasons: DayReason[];
  isLate: boolean;
  minutesLate: number;
  isEarlyOut: boolean;
  minutesEarly: number;
  isShortDay: boolean;
  isHalfDay: boolean;
  hoursWorked: number | null;
  requiredHours: number | null;
  clockIn: string | null;
  clockOut: string | null;
  policySource: string | null;
}

export interface AttendanceStatusResult {
  employeeId: string;
  from: string;
  to: string;
  /** The member's BRANCH IANA timezone — every `date` is a branch-local calendar day. */
  timezone: string;
  policy: {
    startTime: string;
    workHours: number;
    breakHours: number;
    requiredHours: number;
    graceMinutes: number;
    halfDayThresholdHours: number | null;
    source: string;
  };
  days: ClassifiedDay[];
  summary: Record<DayStatus, number>;
}

export function getAttendanceStatus(params: { employeeId?: string; from: string; to: string }): Promise<AttendanceStatusResult> {
  return apiFetch<AttendanceStatusResult>('/attendance/status', { query: params });
}
