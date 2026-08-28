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
