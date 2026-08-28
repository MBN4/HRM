import { apiFetch } from './client';
import type { Employee, EmployeeListResult, OrgChartNode } from './types';

export function getOwnEmployee(): Promise<Employee> {
  return apiFetch<Employee>('/employees/me');
}

export function getEmployee(id: string): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${id}`);
}

export function listEmployees(params: { branchId?: string; departmentId?: string; search?: string; page?: number; pageSize?: number } = {}): Promise<EmployeeListResult> {
  return apiFetch<EmployeeListResult>('/employees', { query: params });
}

export interface UpdateEmployeeInput {
  personalEmail?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  emergencyContacts?: { name: string; relationship: string; phone: string }[];
  dependents?: { name: string; relationship: string; dateOfBirth?: string }[];
}

export function updateEmployee(id: string, input: UpdateEmployeeInput): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${id}`, { method: 'PATCH', body: input });
}

export function getOrgChart(branchId?: string): Promise<OrgChartNode[]> {
  return apiFetch<OrgChartNode[]>('/employees/org-chart', { query: { branchId } });
}
