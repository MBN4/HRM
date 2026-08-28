import { apiFetch } from './client';
import type { LeaveBalance, LeaveCalendarEntry, LeaveRequest, LeaveType } from './types';

export interface SubmitLeaveRequestInput {
  employeeId?: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason?: string;
}

export function submitLeaveRequest(input: SubmitLeaveRequestInput): Promise<LeaveRequest> {
  return apiFetch<LeaveRequest>('/leave/requests', { method: 'POST', body: input });
}

export function listLeaveRequests(params: { employeeId?: string; status?: string; branchId?: string; from?: string; to?: string } = {}): Promise<LeaveRequest[]> {
  return apiFetch<LeaveRequest[]>('/leave/requests', { query: params });
}

export function getLeaveRequest(id: string): Promise<LeaveRequest> {
  return apiFetch<LeaveRequest>(`/leave/requests/${id}`);
}

export function getLeaveBalances(params: { employeeId?: string; year?: number } = {}): Promise<LeaveBalance[]> {
  return apiFetch<LeaveBalance[]>('/leave/balances', { query: params });
}

export function adjustLeaveBalance(employeeId: string, input: { leaveType: LeaveType; periodYear?: number; deltaDays: number; reason?: string }): Promise<LeaveBalance> {
  return apiFetch<LeaveBalance>(`/leave/balances/${employeeId}/adjust`, { method: 'POST', body: input });
}

export function getLeaveCalendar(params: { branchId?: string; departmentId?: string; from: string; to: string }): Promise<LeaveCalendarEntry[]> {
  return apiFetch<LeaveCalendarEntry[]>('/leave/calendar', { query: params });
}

export function getLeaveConflicts(params: { branchId?: string; departmentId?: string; from: string; to: string }): Promise<LeaveRequest[]> {
  return apiFetch<LeaveRequest[]>('/leave/conflicts', { query: params });
}
