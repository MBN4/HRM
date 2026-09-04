/**
 * Plain TypeScript mirrors of `apps/api`'s response DTOs, trimmed to the
 * ESS-only surface this app actually calls — the exact same duplication
 * precedent apps/portal/src/lib/api/types.ts already documents for itself
 * (byte-identical-in-spirit duplication across apps beats a shared
 * package for response DTOs `@hrm/shared` doesn't export). See
 * docs/conventions/employee.md, leave.md, attendance.md for the source of
 * truth these mirror.
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

export type LeaveType = 'ANNUAL' | 'SICK' | 'MATERNITY' | 'PATERNITY';
export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';

export const LEAVE_TYPES: readonly LeaveType[] = ['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY'];

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

// Step 4.3 (white-label) — see docs/conventions/white-label.md. Mirrors
// apps/portal's `PublicBranding` shape; the logo/favicon image itself is
// NOT fetched here (no equivalent of the web's object-URL/blob pattern is
// worth the native-image-caching complexity for this step — a documented
// gap, see that doc's own "Known gaps" section).
export interface PublicBranding {
  productName: string;
  hasLogo: boolean;
  hasFavicon: boolean;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  loginHeadline: string | null;
  loginSubtext: string | null;
  showPoweredBy: boolean;
}
