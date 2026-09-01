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

/** Mirrors `AnalyticsDashboardResponseDto` (apps/api/src/analytics/dashboard) — see docs/conventions/analytics-dashboard.md. Every number here comes from a precomputed rollup table, never a live aggregate. */
export interface AnalyticsDashboard {
  range: { from: string; to: string };
  headcount: {
    asOfDate: string | null;
    total: number;
    byBranch: { branchId: string; count: number }[];
    byDepartment: { departmentId: string | null; count: number }[];
    byEmploymentType: { employmentType: string; count: number }[];
    byGender: { gender: string | null; count: number }[];
  };
  movement: {
    joiners: number;
    leavers: number;
    attritionRate: number;
    byBranch: { branchId: string; joiners: number; leavers: number }[];
  };
  attendance: {
    presentCount: number;
    absentCount: number;
    lateCount: number;
    onLeaveCount: number;
    weekendCount: number;
    holidayCount: number;
    employeeDays: number;
    attendanceRate: number;
    trend: { date: string; presentCount: number; absentCount: number; lateCount: number; employeeCount: number }[];
  };
  leave: {
    byType: { leaveType: string; entitledDays: number; usedToDate: number; usedInPeriod: number; utilizationRate: number }[];
  };
}

// --- Payroll (2.1) — see docs/conventions/payroll.md ------------------

export type PayrollRunStatus = 'DRAFT' | 'CALCULATED' | 'APPROVED' | 'FINALIZED' | 'PAID';
export type PayrollRunLineStatus = 'PENDING' | 'COMPUTED' | 'FAILED';
export type PayrollComputedVia = 'ENGINE' | 'DELEGATE';
export type PayrollComponentType = 'EARNING' | 'ALLOWANCE' | 'DEDUCTION';
export type PayrollComponentCalcKind = 'FIXED_AMOUNT' | 'PERCENTAGE_OF_BASE' | 'FORMULA';

export interface PayrollRunLine {
  id: string;
  employeeId: string;
  status: PayrollRunLineStatus;
  computedVia: PayrollComputedVia | null;
  errorMessage: string | null;
  computedAt: string | null;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'grossPay' in line` rather than truthiness. */
  grossPay?: string | null;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'netPay' in line` rather than truthiness. */
  netPay?: string | null;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'employerCost' in line` rather than truthiness. */
  employerCost?: string | null;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'componentBreakdown' in line` rather than truthiness. */
  componentBreakdown?: unknown;
}

export interface PayrollRun {
  id: string;
  branchId: string;
  periodYear: number;
  periodMonth: number;
  status: PayrollRunStatus;
  payrollMode: string;
  workflowInstanceId: string | null;
  currencyCode: string;
  createdAt: string;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'totalGross' in run` rather than truthiness. */
  totalGross?: string;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'totalNet' in run` rather than truthiness. */
  totalNet?: string;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'totalEmployerCost' in run` rather than truthiness. */
  totalEmployerCost?: string;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'totalGrossBase' in run` rather than truthiness. */
  totalGrossBase?: string | null;
  /** Present only for a caller with `salary.view` — omitted (not null) otherwise. Always check `'totalNetBase' in run` rather than truthiness. */
  totalNetBase?: string | null;
  /** Only present on `GET /payroll/runs/:id` — every list route returns line-less runs. */
  lines?: PayrollRunLine[];
}

/** A raw, unredacted `PayrollComponentDefinition` row (`@hrm/db`) — this route has no field-level gating. */
export interface PayrollComponentDefinition {
  id: string;
  tenantId: string;
  countryCode: string;
  key: string;
  name: string;
  type: PayrollComponentType;
  calcKind: PayrollComponentCalcKind;
  fixedAmount: string | null;
  percentageOfBase: string | null;
  percentageRate: number | null;
  formula: unknown;
  order: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Performance (2.2) — see docs/conventions/performance.md ----------

export type AppraisalCycleType = 'ANNUAL' | 'QUARTERLY' | 'PROBATION';
export type AppraisalCycleStatus = 'DRAFT' | 'OPEN' | 'CLOSED';
export type GoalLevel = 'COMPANY' | 'TEAM' | 'INDIVIDUAL';
export type GoalStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'AT_RISK' | 'COMPLETED' | 'CANCELLED';
export type AppraisalStatus = 'DRAFT' | 'IN_PROGRESS' | 'PENDING_SIGNOFF' | 'COMPLETED' | 'REJECTED';
export type ReviewType = 'SELF' | 'MANAGER' | 'PEER' | 'UPWARD';
export type ReviewAssignmentStatus = 'PENDING' | 'SUBMITTED';

export interface RatingLevel {
  value: number;
  label: string;
  description?: string;
}

export interface RatingScale {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  levels: RatingLevel[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AppraisalCycle {
  id: string;
  tenantId: string;
  name: string;
  cycleType: AppraisalCycleType;
  status: AppraisalCycleStatus;
  startDate: string;
  endDate: string;
  ratingScaleId: string;
  enabledReviewTypes: ReviewType[];
  eligibleBranchIds: string[];
  eligibleDepartmentIds: string[];
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: string;
  tenantId: string;
  level: GoalLevel;
  employeeId: string | null;
  departmentId: string | null;
  parentGoalId: string | null;
  cycleId: string | null;
  title: string;
  description: string | null;
  targetValue: number | null;
  currentValue: number;
  unit: string | null;
  progressPercent: number;
  status: GoalStatus;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface Appraisal {
  id: string;
  tenantId: string;
  cycleId: string;
  employeeId: string;
  status: AppraisalStatus;
  overallRating: number | null;
  workflowInstanceId: string | null;
  submittedForApprovalAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewAssignment {
  id: string;
  tenantId: string;
  appraisalId: string;
  reviewType: ReviewType;
  reviewerId: string;
  status: ReviewAssignmentStatus;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Review {
  id: string;
  tenantId: string;
  assignmentId: string;
  appraisalId: string;
  reviewType: ReviewType;
  reviewerId: string;
  ratingScaleId: string;
  overallRating: number;
  strengths: string | null;
  improvements: string | null;
  comments: string | null;
  submittedAt: string;
}

/**
 * `GET /performance/appraisals/:id` returns the raw, UNREDACTED Prisma
 * `Appraisal` row with `employee`/`assignments`/`reviews` included — no
 * `PermissionSerializerInterceptor` gates it. `employee` is deliberately
 * narrowed here to identity-only fields: never read compensation/statutory
 * data off this route (it isn't there, but nothing stops a future backend
 * change from widening the include — this type is the guardrail).
 */
export interface AppraisalDetail extends Appraisal {
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
    branchId: string;
  };
  assignments: ReviewAssignment[];
  reviews: Review[];
}

export interface CalibrationRow {
  branchId: string;
  departmentId: string | null;
  ratingValue: number;
  employeeCount: number;
}

// --- Recruitment / Onboarding / Offboarding (2.3) — see docs/conventions/recruitment-lifecycle.md ---

export type RecruitmentEmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERN';
export type JobRequisitionStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CLOSED';
export type JobPostingStatus = 'DRAFT' | 'PUBLISHED' | 'CLOSED';
export type ApplicationStage = 'APPLIED' | 'SCREEN' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED';
export type InterviewStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
export type ScorecardRecommendation = 'STRONG_YES' | 'YES' | 'NO' | 'STRONG_NO';
export type OfferStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'ACCEPTED' | 'DECLINED';

export interface JobRequisition {
  id: string;
  title: string;
  branchId: string;
  departmentId: string | null;
  designationId: string | null;
  employmentType: RecruitmentEmploymentType;
  headcount: number;
  justification: string | null;
  status: JobRequisitionStatus;
  workflowInstanceId: string | null;
  createdByUserId: string;
  approvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobPosting {
  id: string;
  requisitionId: string;
  title: string;
  description: string;
  publicSlug: string;
  status: JobPostingStatus;
  publishedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Candidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  /** No download route exists for this — a documented limitation, see docs/conventions/frontend-admin-console.md. */
  resumeStorageKey: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Application {
  id: string;
  candidateId: string;
  jobPostingId: string;
  stage: ApplicationStage;
  appliedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Interview {
  id: string;
  applicationId: string;
  scheduledAt: string;
  durationMinutes: number;
  interviewerUserIds: string[];
  location: string | null;
  status: InterviewStatus;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewScorecard {
  id: string;
  interviewId: string;
  interviewerUserId: string;
  rating: number;
  recommendation: ScorecardRecommendation;
  notes: string | null;
  submittedAt: string;
}

export interface Offer {
  id: string;
  applicationId: string;
  branchId: string;
  departmentId: string | null;
  designationId: string | null;
  employmentType: RecruitmentEmploymentType;
  /** Ungated at the API — a plain `number`, unlike Payroll's string-decimal convention. */
  proposedSalary: number;
  salaryCurrency: string;
  proposedJoinDate: string;
  status: OfferStatus;
  workflowInstanceId: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export type OnboardingProcessStatus = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type OffboardingReason = 'RESIGNATION' | 'TERMINATION';
export type OffboardingProcessStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'COMPLETED';
export type ChecklistProcessType = 'ONBOARDING' | 'OFFBOARDING';
export type ChecklistTaskStatus = 'PENDING' | 'COMPLETED';

/** Mirrors `ChecklistAssigneeRule` (`packages/shared/src/validators/checklist.validator.ts`) — a small, purpose-built "who does this land on" shape, deliberately NOT 0.7's `ApproverRule`. */
export type ChecklistAssigneeRule = { type: 'SPECIFIC_USER'; userId: string } | { type: 'ROLE'; roleName: string } | { type: 'MANAGER' };

export interface ChecklistTaskDefinition {
  key: string;
  title: string;
  category: string;
  assigneeRule: ChecklistAssigneeRule;
  requiresDocument: boolean;
}

export interface ChecklistTemplate {
  id: string;
  tenantId: string;
  processType: ChecklistProcessType;
  name: string;
  isActive: boolean;
  tasks: ChecklistTaskDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistTaskInstance {
  id: string;
  tenantId: string;
  processType: ChecklistProcessType;
  processId: string;
  key: string;
  title: string;
  category: string;
  assigneeUserId: string | null;
  requiresDocument: boolean;
  documentStorageKey: string | null;
  status: ChecklistTaskStatus;
  completedAt: string | null;
  completedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingProcess {
  id: string;
  offerId: string;
  candidateId: string;
  employeeId: string | null;
  status: OnboardingProcessStatus;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OffboardingProcess {
  id: string;
  employeeId: string;
  reason: OffboardingReason;
  lastWorkingDate: string;
  status: OffboardingProcessStatus;
  workflowInstanceId: string | null;
  settlementPayrollRunId: string | null;
  initiatedByUserId: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
