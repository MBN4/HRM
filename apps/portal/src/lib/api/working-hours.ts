import { apiFetch } from './client';

export type WorkingHoursScope = 'COMPANY' | 'TEAM' | 'MEMBER';

/** Mirrors the `/working-hours/*` responses (step 8.1). */
export interface WorkingHoursPolicy {
  id: string;
  scope: WorkingHoursScope;
  target: { id: string; label: string; code?: string } | null;
  startTime: string;
  workHours: number;
  breakHours: number;
  requiredHours: number;
  graceMinutes: number;
  /** null = derived (requiredHours / 2). */
  halfDayThresholdHours: number | null;
  updatedAt: string;
}

export interface WorkingHoursTargets {
  departments: { id: string; name: string; branchName: string }[];
  employees: { id: string; code: string; name: string; departmentId: string | null }[];
}

export interface WorkingHoursInput {
  startTime: string;
  workHours: number;
  breakHours: number;
  graceMinutes: number;
  halfDayThresholdHours: number | null;
}

export type WorkingHoursSource = 'MEMBER' | 'TEAM' | 'COMPANY' | 'COUNTRY_PACK';

export interface EffectiveWorkingHours {
  employeeId: string;
  branchId: string;
  timezone: string;
  date: string;
  policy: {
    startTime: string;
    workHours: number;
    breakHours: number;
    requiredHours: number;
    graceMinutes: number;
    halfDayThresholdHours: number;
    halfDayThresholdDerived: boolean;
  };
  source: WorkingHoursSource;
  policyId: string | null;
  sourceDepartmentId: string | null;
}

export const listWorkingHoursPolicies = () => apiFetch<WorkingHoursPolicy[]>('/working-hours/policies');
export const getWorkingHoursTargets = () => apiFetch<WorkingHoursTargets>('/working-hours/targets');
export const saveCompanyPolicy = (body: WorkingHoursInput) => apiFetch('/working-hours/company', { method: 'PUT', body });
export const saveTeamPolicy = (departmentId: string, body: WorkingHoursInput) =>
  apiFetch(`/working-hours/teams/${departmentId}`, { method: 'PUT', body });
export const saveMemberPolicy = (employeeId: string, body: WorkingHoursInput) =>
  apiFetch(`/working-hours/members/${employeeId}`, { method: 'PUT', body });
export const deleteTeamPolicy = (departmentId: string) => apiFetch(`/working-hours/teams/${departmentId}`, { method: 'DELETE' });
export const deleteMemberPolicy = (employeeId: string) => apiFetch(`/working-hours/members/${employeeId}`, { method: 'DELETE' });
export const getEffectiveWorkingHours = (employeeId: string, date?: string) =>
  apiFetch<EffectiveWorkingHours>('/working-hours/effective', { query: { employeeId, date } });
