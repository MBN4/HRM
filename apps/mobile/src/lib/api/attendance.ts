import { apiFetch } from './client';
import type { AttendanceRecord, AttendanceRegularization, AttendanceSource } from './types';

/** React Native's `fetch`/`FormData` takes a `{ uri, name, type }` descriptor for a file part, not a web `File` object — the RN-native shape for whatever `expo-image-picker` (see ../pickSelfie.ts) hands back. */
export interface MobilePhoto {
  uri: string;
  name: string;
  type: string;
}

export interface ClockInOutInput {
  employeeId?: string;
  source?: Extract<AttendanceSource, 'WEB' | 'MOBILE'>;
  lat?: number;
  long?: number;
  photo?: MobilePhoto | null;
}

function toFormData(input: ClockInOutInput): FormData {
  const form = new FormData();
  if (input.employeeId) form.append('employeeId', input.employeeId);
  // MOBILE — this is the whole reason that AttendanceSource enum value
  // exists (see docs/conventions/attendance.md's "Geo-fencing is per-branch,
  // opt-in, and only meaningful for self-service sources").
  form.append('source', input.source ?? 'MOBILE');
  if (input.lat !== undefined) form.append('lat', String(input.lat));
  if (input.long !== undefined) form.append('long', String(input.long));
  if (input.photo) {
    // React Native's FormData accepts this object shape directly (it is
    // NOT a real Blob/File) — the RN fetch polyfill knows how to read it.
    form.append('photo', input.photo as unknown as Blob);
  }
  return form;
}

export function clockIn(input: ClockInOutInput): Promise<AttendanceRecord> {
  return apiFetch<AttendanceRecord>('/attendance/clock-in', { method: 'POST', body: toFormData(input) });
}

export function clockOut(input: ClockInOutInput): Promise<AttendanceRecord> {
  return apiFetch<AttendanceRecord>('/attendance/clock-out', { method: 'POST', body: toFormData(input) });
}

export function listAttendanceRecords(params: { employeeId?: string; from?: string; to?: string } = {}): Promise<AttendanceRecord[]> {
  return apiFetch<AttendanceRecord[]>('/attendance/records', { query: params });
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
