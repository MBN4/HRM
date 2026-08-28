import { apiFetch } from './client';
import type { Employee } from './types';

export function getOwnEmployee(): Promise<Employee> {
  return apiFetch<Employee>('/employees/me');
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
