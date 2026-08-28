import { apiFetch } from './client';
import type { LeaveBalance, LeaveRequest, LeaveType } from './types';

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

export function listLeaveRequests(params: { employeeId?: string; status?: string } = {}): Promise<LeaveRequest[]> {
  return apiFetch<LeaveRequest[]>('/leave/requests', { query: params });
}

export function getLeaveBalances(params: { employeeId?: string; year?: number } = {}): Promise<LeaveBalance[]> {
  return apiFetch<LeaveBalance[]>('/leave/balances', { query: params });
}
