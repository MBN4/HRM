import { apiFetch } from './client';

/**
 * Typed client for `/scheduling/*` (step 8.2) — mirrors the response shapes of
 * apps/api/src/scheduling/*.service.ts and attendance/shifts/shifts.service.ts. The request
 * types mirror packages/shared/src/validators/scheduling.validator.ts.
 */

export type RosterStatus = 'DRAFT' | 'PUBLISHED';
export type SwapStatus = 'AWAITING_PEER' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DECLINED' | 'CANCELED';
export type ScheduleDayKind = 'SHIFT' | 'DAY_OFF' | 'DEFAULT_HOURS' | 'WEEKEND' | 'HOLIDAY' | 'LEAVE';

export interface ShiftHours {
  startTime: string;
  workHours: number;
  breakHours: number;
  requiredHours: number;
  graceMinutes: number;
  halfDayThresholdHours: number;
  halfDayThresholdDerived: boolean;
}

/** `GET /scheduling/shifts` — a ShiftDefinition row plus derived hours and usage counts. */
export interface ShiftDefinition {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  crossesMidnight: boolean;
  graceMinutes: number;
  halfDayThresholdHours: number | null;
  color: string | null;
  minStaffing: number | null;
  hours: ShiftHours;
  usage: { standing: number; roster: number };
}

export interface ShiftInput {
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  graceMinutes: number;
  halfDayThresholdHours: number | null;
  color: string | null;
  minStaffing: number | null;
}

/** The slim shift the grid/coverage responses carry. */
export interface GridShift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  color: string | null;
  requiredHours: number;
  minStaffing: number | null;
}

export interface SchedulingPeople {
  tenantWide: boolean;
  departments: { id: string; name: string; branchName: string }[];
  employees: { id: string; code: string; name: string; departmentId: string | null; branchId: string }[];
}

export interface GridBranch {
  name: string;
  timezone: string;
  /** Upper-case weekday names (WEEKDAYS in @hrm/shared), e.g. "SATURDAY". */
  weekendDays: string[];
  holidays: string[];
}

export interface GridEmployee {
  id: string;
  code: string;
  name: string;
  branchId: string;
  departmentId: string | null;
  departmentName: string | null;
  hasLogin: boolean;
  standing: { source: string; shiftId: string | null; startTime: string | null; requiredHours: number | null };
}

export interface GridCell {
  employeeId: string;
  date: string;
  shiftId: string | null;
  dayOff: boolean;
  status: RosterStatus;
  assignmentId: string;
  note: string | null;
  fromRange: boolean;
}

export interface RosterGrid {
  from: string;
  to: string;
  days: string[];
  canDefineShifts: boolean;
  shifts: GridShift[];
  branches: Record<string, GridBranch>;
  employees: GridEmployee[];
  cells: GridCell[];
  leave: { employeeId: string; date: string }[];
}

export interface CoverageShiftDay {
  shiftId: string;
  count: number;
  minStaffing: number | null;
  gap: boolean;
  people: { employeeId: string; name: string; via: 'ROSTER' | 'STANDING'; status: RosterStatus }[];
}

export interface CoverageDay {
  date: string;
  workingDay: boolean;
  shifts: CoverageShiftDay[];
  defaultHours: number;
  defaultHoursPeople: { employeeId: string; name: string }[];
  off: number;
  onLeave: number;
}

export interface Coverage {
  from: string;
  to: string;
  shifts: { id: string; name: string; startTime: string; endTime: string; color: string | null; minStaffing: number | null }[];
  headcount: number;
  days: CoverageDay[];
  gaps: { date: string; shiftId: string; count: number; minStaffing: number | null }[];
}

export interface StandingRow {
  id: string;
  scope: 'COMPANY' | 'TEAM' | 'MEMBER';
  kind: 'SHIFT' | 'CUSTOM';
  shift: { id: string; name: string; startTime: string; endTime: string; color: string | null } | null;
  target: { id: string; label: string; code?: string } | null;
  updatedAt: string;
}

export interface RosterCellInput {
  employeeId: string;
  date: string;
  shiftDefinitionId?: string | null;
  dayOff?: boolean;
}

export interface MyScheduleDay {
  date: string;
  kind: ScheduleDayKind;
  via: 'ROSTER' | 'STANDING' | null;
  shift: { id: string; name: string; startTime: string; endTime: string; crossesMidnight: boolean; color: string | null } | null;
  startTime: string | null;
  requiredHours: number | null;
  swap: { id: string; status: SwapStatus; mine: boolean } | null;
}

export interface MySchedule {
  employeeId: string;
  timezone: string;
  today: string;
  from: string;
  to: string;
  days: MyScheduleDay[];
}

export interface ShiftSwap {
  id: string;
  date: string;
  status: SwapStatus;
  reason: string | null;
  requester: { id: string; name: string } | null;
  counterpart: { id: string; name: string } | null;
  requesterShift: { id: string; name: string; startTime: string; endTime: string } | null;
  counterpartShift: { id: string; name: string; startTime: string; endTime: string } | null;
  workflowInstanceId: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface Colleague {
  id: string;
  name: string;
  departmentId: string | null;
}

const win = (from: string, to: string, departmentId?: string) => ({ from, to, departmentId: departmentId || undefined });

export const listShifts = () => apiFetch<ShiftDefinition[]>('/scheduling/shifts');
export const createShift = (body: ShiftInput) => apiFetch<ShiftDefinition>('/scheduling/shifts', { method: 'POST', body });
export const updateShift = (id: string, body: Partial<ShiftInput>) => apiFetch<ShiftDefinition>(`/scheduling/shifts/${id}`, { method: 'PATCH', body });
export const deleteShift = (id: string) => apiFetch(`/scheduling/shifts/${id}`, { method: 'DELETE' });

export const getSchedulingPeople = () => apiFetch<SchedulingPeople>('/scheduling/people');
export const getRosterGrid = (from: string, to: string, departmentId?: string) => apiFetch<RosterGrid>('/scheduling/roster', { query: win(from, to, departmentId) });
export const getCoverage = (from: string, to: string, departmentId?: string) => apiFetch<Coverage>('/scheduling/coverage', { query: win(from, to, departmentId) });
export const setRosterCells = (cells: RosterCellInput[]) => apiFetch('/scheduling/roster/cells', { method: 'PUT', body: { cells } });
export const copyRoster = (body: { sourceFrom: string; sourceTo: string; targetFrom: string; departmentId?: string }) =>
  apiFetch<{ copied: number; created: number; updated: number; cleared: number; unchanged: number }>('/scheduling/roster/copy', { method: 'POST', body });
export const publishRoster = (body: { from: string; to: string; departmentId?: string }) =>
  apiFetch<{ published: number; employees: number }>('/scheduling/roster/publish', { method: 'POST', body });

export const listStanding = () => apiFetch<StandingRow[]>('/scheduling/standing');
export const setStanding = (scope: 'company' | 'teams' | 'members', targetId: string | null, shiftDefinitionId: string) =>
  apiFetch(`/scheduling/standing/${scope}${targetId ? `/${targetId}` : ''}`, { method: 'PUT', body: { shiftDefinitionId } });
export const clearStanding = (scope: 'company' | 'teams' | 'members', targetId: string | null) =>
  apiFetch(`/scheduling/standing/${scope}${targetId ? `/${targetId}` : ''}`, { method: 'DELETE' });

export const getMySchedule = (from?: string, to?: string) => apiFetch<MySchedule>('/scheduling/my-schedule', { query: { from, to } });
export const listColleagues = () => apiFetch<Colleague[]>('/scheduling/colleagues');
export const listSwaps = (scope: 'mine' | 'team') => apiFetch<ShiftSwap[]>('/scheduling/swaps', { query: { scope } });
export const requestSwap = (body: { date: string; counterpartEmployeeId: string; reason?: string }) => apiFetch<ShiftSwap>('/scheduling/swaps', { method: 'POST', body });
export const respondSwap = (id: string, accept: boolean) => apiFetch<ShiftSwap>(`/scheduling/swaps/${id}/respond`, { method: 'POST', body: { accept } });
export const cancelSwap = (id: string) => apiFetch<ShiftSwap>(`/scheduling/swaps/${id}/cancel`, { method: 'POST' });
