/**
 * Plain TypeScript mirrors of `apps/api`'s response DTOs — deliberately
 * duplicated here rather than added to `@hrm/shared` (which is framework-
 * agnostic-but-still-only-request-side today: it exports zod `Input` types
 * for REQUEST bodies, never the API's response `class` DTOs). This follows
 * the same precedent `I18nProvider.tsx` already sets in this codebase
 * (byte-identical duplication across apps beats a shared package for a
 * handful of files used by few consumers) — see
 * docs/conventions/frontend-ess-mss.md.
 */

export interface MeResponse {
  userId: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
  branchIds: string[] | null;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  userId: string;
  roles: string[];
  permissions: string[];
  branchIds: string[] | null;
}

export interface EmployeeBankDetails {
  accountNumber: string;
  bankName: string;
  routingCode: string | null;
}

export interface EmployeeCompensation {
  baseSalary: number;
  salaryCurrency: string | null;
}

export interface EmployeeDependent {
  id: string;
  name: string;
  relationship: string;
  dateOfBirth: string | null;
}

export interface EmployeeEmergencyContact {
  id: string;
  name: string;
  relationship: string;
  phone: string;
}

export interface Employee {
  id: string;
  employeeCode: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  personalEmail: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  branchId: string;
  departmentId: string | null;
  designationId: string | null;
  employmentType: string;
  joinDate: string;
  status: string;
  managerId: string | null;
  statutoryFields: Record<string, string>;
  bankDetails: EmployeeBankDetails | null;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'compensation' in employee` rather than truthiness. */
  compensation?: EmployeeCompensation | null;
  dependents: EmployeeDependent[];
  emergencyContacts: EmployeeEmergencyContact[];
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeListResult {
  data: Employee[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrgChartNode {
  id: string;
  firstName: string;
  lastName: string;
  designationId: string | null;
  directReports: OrgChartNode[];
}

export type LeaveType = 'ANNUAL' | 'SICK' | 'MATERNITY' | 'PATERNITY';
export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';

export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: LeaveRequestStatus;
  workflowInstanceId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeaveBalance {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  periodYear: number;
  entitledDays: number;
  accruedDays: number;
  carriedOverDays: number;
  usedDays: number;
  availableDays: number;
}

export interface LeaveCalendarEntry {
  employeeId: string;
  employeeName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
}

export type AttendanceSource = 'WEB' | 'MOBILE' | 'BIOMETRIC' | 'MANUAL';
export type AttendanceRecordStatus = 'OPEN' | 'CLOSED';

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  branchId: string;
  workDate: string;
  shiftDefinitionId: string | null;
  clockInAt: string;
  clockInSource: AttendanceSource;
  clockInLat: number | null;
  clockInLong: number | null;
  clockOutAt: string | null;
  clockOutSource: AttendanceSource | null;
  clockOutLat: number | null;
  clockOutLong: number | null;
  status: AttendanceRecordStatus;
  workedMinutes: number | null;
  overtimeMinutes: number;
  lateMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export type AttendanceRegularizationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';

export interface AttendanceRegularization {
  id: string;
  employeeId: string;
  attendanceRecordId: string | null;
  workDate: string;
  requestedClockInAt: string | null;
  requestedClockOutAt: string | null;
  reason: string;
  status: AttendanceRegularizationStatus;
  workflowInstanceId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AttendanceDayStatus = 'PRESENT' | 'LATE' | 'ABSENT' | 'ON_LEAVE' | 'WEEKEND' | 'HOLIDAY';

export interface AttendanceDailySummary {
  id: string;
  employeeId: string;
  branchId: string;
  workDate: string;
  status: AttendanceDayStatus;
  workedMinutes: number;
  overtimeMinutes: number;
  lateMinutes: number;
  computedAt: string;
}

export type WorkflowInstanceStatus = 'PENDING' | 'IN_STEP' | 'APPROVED' | 'REJECTED' | 'CANCELED' | 'ESCALATED';
export type WorkflowStepStatus = 'PENDING' | 'SKIPPED' | 'ACTIVE' | 'APPROVED' | 'REJECTED';

export interface WorkflowInstanceStep {
  id: string;
  tenantId: string;
  instanceId: string;
  templateStepId: string;
  name: string;
  order: number;
  status: WorkflowStepStatus;
  eligibleApproverIds: string[];
  delegatedToUserId: string | null;
  escalatedToUserId: string | null;
  activatedAt: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowInstance {
  id: string;
  tenantId: string;
  templateId: string;
  entityType: string;
  entityId: string;
  requesterId: string;
  dataSnapshot: Record<string, unknown>;
  status: WorkflowInstanceStatus;
  currentOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface WorkflowAction {
  id: string;
  instanceId: string;
  instanceStepId: string | null;
  actionType: string;
  actorUserId: string | null;
  comment: string | null;
  createdAt: string;
}

export interface WorkflowInstanceDetail {
  instance: WorkflowInstance;
  steps: WorkflowInstanceStep[];
  actions: WorkflowAction[];
}

export interface NotificationDelivery {
  id: string;
  notificationId: string;
  channel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  renderedSubject: string | null;
  renderedBody: string | null;
  sentAt: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationItem {
  id: string;
  eventType: string;
  createdAt: string;
  delivery: NotificationDelivery;
}

export interface NotificationPreference {
  eventType: string;
  channel: string;
  enabled: boolean;
}

export interface Branch {
  id: string;
  name: string;
  countryCode: string;
}

export interface CountryPackLocale {
  currencyCode: string;
  currencySymbol: string;
  numberFormat: string;
  dateFormat: string;
  defaultLanguage: string;
  rtl: boolean;
  firstDayOfWeek: number;
}

export interface CountryPackWorkingTime {
  standardWeeklyHours: number;
  weekendDays: number[];
  overtimeRules: { dailyThresholdHours?: number; weeklyThresholdHours?: number; multiplier: number };
}

export interface EffectiveCountryPackConfig {
  locale: CountryPackLocale;
  workingTime: CountryPackWorkingTime;
  leaveDefaults: { annualDays: number; sickDays: number; maternityDays: number; paternityDays: number };
  publicHolidays: Record<string, { date: string; name: string }[]>;
  [key: string]: unknown;
}
