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

// --- Operations modules (step 3.1) — see docs/conventions/operations-modules.md ---

export type ExpenseClaimStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'REIMBURSED';

export interface ExpenseCategory {
  id: string;
  code: string;
  name: string;
  policyLimitAmount: string | null;
  isActive: boolean;
}

export interface ExpenseLine {
  id: string;
  expenseClaimId: string;
  categoryId: string;
  description: string;
  amount: string;
  expenseDate: string;
  receiptStorageKey: string | null;
}

export interface ExpenseClaim {
  id: string;
  employeeId: string;
  branchId: string;
  currencyCode: string;
  totalAmount: string;
  totalAmountBaseCurrency: string | null;
  status: ExpenseClaimStatus;
  workflowInstanceId: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  reimbursementPayrollRunLineId: string | null;
  reimbursedAt: string | null;
  createdAt: string;
  lines?: ExpenseLine[];
}

export type AssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'IN_MAINTENANCE' | 'RETIRED';
export type AssetAssignmentStatus = 'ASSIGNED' | 'RETURNED';
export type AssetMaintenanceStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED';

export interface AssetCategory {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface Asset {
  id: string;
  categoryId: string;
  branchId: string | null;
  assetTag: string;
  name: string;
  serialNumber: string | null;
  status: AssetStatus;
  purchaseDate: string | null;
  purchaseCost: string | null;
}

export interface AssetAssignment {
  id: string;
  assetId: string;
  employeeId: string;
  status: AssetAssignmentStatus;
  assignedAt: string;
  assignedByUserId: string;
  condition: string | null;
  notes: string | null;
  returnedAt: string | null;
  returnedByUserId: string | null;
  returnCondition: string | null;
  asset?: Asset;
}

export interface AssetMaintenanceRecord {
  id: string;
  assetId: string;
  description: string;
  status: AssetMaintenanceStatus;
  startedAt: string | null;
  completedAt: string | null;
  cost: string | null;
}

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

export interface TicketCategory {
  id: string;
  code: string;
  name: string;
  defaultSlaMinutes: number | null;
  isActive: boolean;
}

export interface Ticket {
  id: string;
  categoryId: string;
  raisedByUserId: string;
  employeeId: string | null;
  branchId: string | null;
  subject: string;
  description: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignedToUserId: string | null;
  slaDueAt: string | null;
  slaBreached: boolean;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

export interface TicketAttachment {
  id: string;
  ticketId: string;
  storageKey: string;
  fileName: string;
  uploadedByUserId: string;
  createdAt: string;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  publishedByUserId: string;
  isActive: boolean;
  publishedAt: string | null;
  targetBranchIds: string[];
  targetDepartmentIds: string[];
  createdAt: string;
}

export interface Policy {
  id: string;
  title: string;
  body: string;
  version: number;
  isActive: boolean;
  requiresAcknowledgment: boolean;
  attachmentStorageKey: string | null;
  publishedByUserId: string;
  publishedAt: string | null;
  createdAt: string;
}

export interface PolicyAcknowledgment {
  id: string;
  policyId: string;
  userId: string;
  acknowledgedAt: string;
}

// --- Learning & Development (step 3.2) — see docs/conventions/lms.md. ---

export type CourseStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type ContentItemType = 'VIDEO' | 'DOCUMENT' | 'LINK';
export type EnrollmentStatus = 'ENROLLED' | 'IN_PROGRESS' | 'COMPLETED';
export type EnrollmentSource = 'SELF' | 'ASSIGNED';
export type ContentProgressStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
export type CertificationStatus = 'ACTIVE' | 'EXPIRED' | 'RENEWED';

export interface CourseCategory {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface Course {
  id: string;
  categoryId: string | null;
  title: string;
  description: string | null;
  status: CourseStatus;
  isMandatory: boolean;
  validityMonths: number | null;
  createdByUserId: string;
  publishedAt: string | null;
  createdAt: string;
}

export interface CourseContentItem {
  id: string;
  courseId: string;
  moduleName: string | null;
  orderIndex: number;
  type: ContentItemType;
  title: string;
  storageKey: string | null;
  externalUrl: string | null;
  durationMinutes: number | null;
}

export interface CourseWithContent extends Course {
  contentItems: CourseContentItem[];
}

export interface QuizOption {
  key: string;
  text: string;
}

/** Present only when authored via the admin route — `GET /lms/courses/:id/quiz` (taking) never includes it. */
export interface QuizQuestion {
  id: string;
  quizId: string;
  orderIndex: number;
  questionText: string;
  options: QuizOption[];
  correctOptionKey?: string;
  points: number;
}

export interface Quiz {
  id: string;
  courseId: string;
  title: string;
  passMarkPercent: number;
  isRequired: boolean;
  questions?: QuizQuestion[];
}

export interface QuizAttempt {
  id: string;
  quizId: string;
  enrollmentId: string;
  employeeId: string;
  scorePercent: number;
  passed: boolean;
  answers: Record<string, string>;
  attemptedAt: string;
}

export interface ContentProgress {
  id: string;
  enrollmentId: string;
  contentItemId: string;
  status: ContentProgressStatus;
  completedAt: string | null;
}

export interface Enrollment {
  id: string;
  courseId: string;
  employeeId: string;
  branchId: string;
  source: EnrollmentSource;
  status: EnrollmentStatus;
  enrolledByUserId: string | null;
  dueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  progress?: ContentProgress[];
}

export interface Certification {
  id: string;
  courseId: string;
  employeeId: string;
  enrollmentId: string;
  status: CertificationStatus;
  issuedAt: string;
  expiresAt: string | null;
  renewedFromCertificationId: string | null;
}

export interface RequiredTraining {
  id: string;
  courseId: string;
  roleId: string | null;
  branchId: string | null;
  isActive: boolean;
}

export interface ComplianceGapRow {
  employeeId: string;
  employeeName: string;
  courseId: string;
  courseTitle: string;
  bucket: 'EXPIRING' | 'EXPIRED' | 'MISSING';
  expiresAt: string | null;
}

export interface TrainingCalendarEntry {
  type: 'ENROLLMENT_DUE' | 'CERTIFICATION_EXPIRY';
  date: string;
  employeeId: string;
  employeeName: string;
  courseId: string;
  courseTitle: string;
}

export interface CourseCompletionKpi {
  courseId: string;
  branchId: string;
  departmentId: string | null;
  enrolledCount: number;
  inProgressCount: number;
  completedCount: number;
}

export interface TrainingComplianceKpi {
  courseId: string;
  branchId: string;
  departmentId: string | null;
  requiredCount: number;
  compliantCount: number;
  expiringCount: number;
  expiredCount: number;
  missingCount: number;
}

export interface ComplianceDashboardResult {
  completion: CourseCompletionKpi[];
  compliance: TrainingComplianceKpi[];
}

// --- Billing (step 4.2) — see docs/conventions/billing.md. ---

export type TenantEdition = 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE';
export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';

export interface SubscriptionSummary {
  edition: TenantEdition;
  status: SubscriptionStatus;
  currency: string;
  quantity: number | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface InvoiceSummary {
  id: string;
  type: 'SUBSCRIPTION' | 'SETUP_FEE' | 'AMC';
  status: 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';
  currency: string;
  amountDue: string;
  amountPaid: string;
  amountRemaining: string;
  description: string | null;
  dueDate: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export interface PaymentMethodSummary {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

export interface BillingSummary {
  subscription: SubscriptionSummary & { hasPaymentMethod: boolean };
  activeSeats: number;
  invoices: InvoiceSummary[];
  paymentMethods: PaymentMethodSummary[];
}

export interface ChangePlanResult {
  subscription: SubscriptionSummary;
  prorationPreviewMinorUnits: string;
}

export interface PlatformSubscriptionSummary {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: string;
  edition: string;
  status: string;
  quantity: number | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

// Step 4.3 — white-label / branding. See docs/conventions/white-label.md.
export interface PublicBranding {
  productName: string;
  hasLogo: boolean;
  hasFavicon: boolean;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  loginHeadline: string | null;
  loginSubtext: string | null;
  /** LIVE entitlement-derived — false only when full-rebrand is BOTH enabled AND currently entitled. Never trust a stale copy of this. */
  showPoweredBy: boolean;
}

export interface BrandingDomain {
  id: string;
  domain: string;
  verificationStatus: 'PENDING_VERIFICATION' | 'VERIFIED' | 'FAILED';
  certStatus: 'NONE' | 'PENDING' | 'ISSUED' | 'FAILED';
  certProvisionedAt: string | null;
  certExpiresAt: string | null;
  createdAt: string;
  /** Only present on the response to a fresh `POST /branding/domain` — instructs the admin what DNS TXT record to publish. */
  dnsRecordName?: string;
  dnsRecordValue?: string;
}

export interface BrandingSettings extends PublicBranding {
  emailFromName: string | null;
  emailFromAddress: string | null;
  fullRebrandEnabled: boolean;
  /** Whether FEATURE_FLAGS.FULL_REBRAND is currently entitled — the toggle in the UI should be disabled with an upsell notice when false. */
  fullRebrandEntitled: boolean;
  domain: BrandingDomain | null;
}

// Data migration & onboarding toolkit (step 3.5.1) — see
// docs/conventions/data-migration.md. `ImportEntityTypeKey`/`ImportFieldSpec`/
// `IMPORT_ENTITY_FIELDS` are imported straight from `@hrm/shared` (pure data,
// no framework dependency) rather than duplicated here — unlike this file's
// usual "mirror the backend DTO" convention, there is no backend DTO class
// to mirror for that catalog, just a shared constant.
export type ImportBatchStatus =
  | 'UPLOADED'
  | 'VALIDATING'
  | 'DRY_RUN_COMPLETE'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'COMMITTED_WITH_ERRORS'
  | 'FAILED';

export interface ImportBatch {
  id: string;
  entityType: string;
  mode: 'PARTIAL' | 'ALL_OR_NOTHING';
  status: ImportBatchStatus;
  fileName: string;
  fileFormat: 'CSV' | 'XLSX';
  columnMapping: Record<string, string>;
  columnMappingTemplateId: string | null;
  totalRows: number;
  processedRows: number;
  createCount: number;
  updateCount: number;
  skipCount: number;
  errorCount: number;
  dryRunCompletedAt: string | null;
  committedAt: string | null;
  failureReason: string | null;
  initiatedByUserId: string | null;
  initiatedByPlatformAdminId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportRowError {
  id: string;
  importBatchId: string;
  phase: 'DRY_RUN' | 'COMMIT';
  rowNumber: number;
  message: string;
  rowData: Record<string, unknown>;
  createdAt: string;
}

export interface ColumnMappingTemplate {
  id: string;
  entityType: string;
  name: string;
  mapping: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
