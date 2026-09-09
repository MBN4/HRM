/**
 * The default permission catalog and system-role → permission mapping.
 *
 * These constants are ONLY the seed defaults — see
 * `packages/db/src/seed-rbac.ts` — used to populate a tenant's `Permission`
 * and `Role` rows when it's provisioned. Enforcement (`PermissionsGuard`,
 * `@RequiresPermission()`) always reads the current `Role`/`Permission`
 * rows from the database, never these constants directly: a tenant admin
 * can rename a role or edit its permission set with no code change, and
 * that takes effect immediately. Don't import these into request-time
 * authorization logic — only into seeding/provisioning code.
 */
export const PERMISSIONS = {
  EMPLOYEE_READ: 'employee.read',
  EMPLOYEE_WRITE: 'employee.write',
  PAYROLL_RUN: 'payroll.run',
  SALARY_VIEW: 'salary.view',
  BRANCH_MANAGE: 'branch.manage',
  ROLE_MANAGE: 'role.manage',
  USER_MANAGE: 'user.manage',
  COUNTRY_PACK_OVERRIDE_MANAGE: 'country_pack.override.manage',
  LICENSE_MANAGE: 'license.manage',
  WORKFLOW_PARTICIPATE: 'workflow.participate',
  WORKFLOW_MANAGE: 'workflow.manage',
  AUDIT_READ: 'audit.read',
  CUSTOM_FIELD_MANAGE: 'custom_field.manage',
  LEAVE_READ: 'leave.read',
  LEAVE_WRITE: 'leave.write',
  LEAVE_APPROVE: 'leave.approve',
  ATTENDANCE_READ: 'attendance.read',
  ATTENDANCE_WRITE: 'attendance.write',
  ATTENDANCE_APPROVE: 'attendance.approve',
  ATTENDANCE_REGULARIZE: 'attendance.regularize',
  ANALYTICS_READ: 'analytics.read',
  PAYROLL_APPROVE: 'payroll.approve',
  PAYSLIP_VIEW: 'payslip.view',
  PERFORMANCE_READ: 'performance.read',
  PERFORMANCE_WRITE: 'performance.write',
  PERFORMANCE_REVIEW: 'performance.review',
  PERFORMANCE_MANAGE: 'performance.manage',
  RECRUITMENT_READ: 'recruitment.read',
  RECRUITMENT_WRITE: 'recruitment.write',
  RECRUITMENT_MANAGE: 'recruitment.manage',
  ONBOARDING_MANAGE: 'onboarding.manage',
  OFFBOARDING_MANAGE: 'offboarding.manage',
  EXPENSE_READ: 'expense.read',
  EXPENSE_WRITE: 'expense.write',
  EXPENSE_MANAGE: 'expense.manage',
  ASSET_READ: 'asset.read',
  ASSET_MANAGE: 'asset.manage',
  HELPDESK_READ: 'helpdesk.read',
  HELPDESK_WRITE: 'helpdesk.write',
  HELPDESK_MANAGE: 'helpdesk.manage',
  ANNOUNCEMENT_READ: 'announcement.read',
  ANNOUNCEMENT_MANAGE: 'announcement.manage',
  POLICY_READ: 'policy.read',
  POLICY_MANAGE: 'policy.manage',
  LMS_READ: 'lms.read',
  LMS_ENROLL: 'lms.enroll',
  LMS_AUTHOR: 'lms.author',
  LMS_ASSIGN: 'lms.assign',
  LMS_MANAGE: 'lms.manage',
  // Step 3.3 (Integrations) — ownership/security territory, the same
  // reasoning ROLE_MANAGE/LICENSE_MANAGE/AUDIT_READ already document:
  // managing outbound webhook subscriptions, minting/revoking programmatic
  // API credentials, configuring SSO, and configuring third-party
  // integration credentials (Slack, biometric devices, accounting export)
  // are security-sensitive, tenant-ownership-level actions — TENANT_ADMIN
  // only (via ALL_PERMISSIONS), deliberately NOT copied into HR_MANAGER's
  // list below.
  WEBHOOK_MANAGE: 'webhook.manage',
  API_KEY_MANAGE: 'api_key.manage',
  SSO_MANAGE: 'sso.manage',
  INTEGRATION_MANAGE: 'integration.manage',
  // Step 4.2 (billing) — viewing/managing the tenant's own SaaS
  // subscription, plan, payment methods, and invoices. Ownership/security-
  // and-money territory, the SAME reasoning LICENSE_MANAGE/AUDIT_READ
  // already document for themselves — TENANT_ADMIN only (via
  // ALL_PERMISSIONS), deliberately NOT copied into HR_MANAGER's list.
  BILLING_MANAGE: 'billing.manage',
  // Step 4.3 (white-label) — managing the tenant's own branding (logo,
  // colors, product name, favicon, login-page copy, email sender identity,
  // custom domain requests, and — if entitled — the full-rebrand toggle).
  // Ownership territory, the SAME reasoning BILLING_MANAGE/LICENSE_MANAGE
  // already document for themselves — TENANT_ADMIN only (via
  // ALL_PERMISSIONS), deliberately NOT copied into HR_MANAGER's list.
  BRANDING_MANAGE: 'branding.manage',
  // Step 3.5.1 (data migration & onboarding toolkit) — self-serve import of
  // a new client's existing HR data. Setup/onboarding territory rather than
  // day-to-day HR policy, but unlike BILLING_MANAGE/BRANDING_MANAGE this is
  // work HR_MANAGER genuinely owns in practice (the same reasoning
  // COUNTRY_PACK_OVERRIDE_MANAGE/CUSTOM_FIELD_MANAGE already document for
  // themselves) — granted to TENANT_ADMIN (via ALL_PERMISSIONS) and
  // explicitly to HR_MANAGER, deliberately NOT MANAGER/EMPLOYEE.
  MIGRATION_MANAGE: 'migration.manage',
  // Step 3.5.2 (benefits administration) — the same read/self-service/
  // manage split EXPENSE_READ/EXPENSE_WRITE/EXPENSE_MANAGE already
  // establish: BENEFITS_READ (view plans + your own enrollments — seeded
  // onto every role including EMPLOYEE), BENEFITS_ENROLL (self-elect a
  // self-election-enabled plan, add/remove your own dependents — also
  // seeded broadly), BENEFITS_MANAGE (define plans, enroll/unenroll ANY
  // employee, view branch-scoped cost reporting — TENANT_ADMIN/HR_MANAGER
  // only).
  BENEFITS_READ: 'benefits.read',
  BENEFITS_ENROLL: 'benefits.enroll',
  BENEFITS_MANAGE: 'benefits.manage',
  // Step 3.5.3 (e-signatures) — see docs/conventions/e-signatures.md.
  // ESIGNATURE_REQUEST (create/send a signature request — TENANT_ADMIN/
  // HR_MANAGER only, the same ownership-territory tier RECRUITMENT_MANAGE/
  // ONBOARDING_MANAGE already occupy) vs. ESIGNATURE_MANAGE (cancel any
  // request, view the full tenant-wide tracking list, download any
  // certificate — also TENANT_ADMIN/HR_MANAGER) vs. ESIGNATURE_SIGN (sign a
  // document YOU were named as an internal signer on — seeded broadly, onto
  // every role including EMPLOYEE, the same self-service tier
  // EXPENSE_READ/HELPDESK_READ already establish). A caller with only
  // POLICY_READ may additionally self-request a signature for their OWN
  // policy acknowledgment — a service-layer row check
  // (`SignatureRequestService.create`), not a fourth permission, the same
  // "gated at the row level, an explicit manage-tier permission widens who
  // may act" shape InterviewScorecard submission already establishes (see
  // docs/conventions/recruitment-lifecycle.md). External signers (no
  // account) never hold any permission — they authenticate via a scoped
  // signing token instead, never RBAC.
  ESIGNATURE_REQUEST: 'esignature.request',
  ESIGNATURE_MANAGE: 'esignature.manage',
  ESIGNATURE_SIGN: 'esignature.sign',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly PermissionKey[] = Object.values(PERMISSIONS);

export const SYSTEM_ROLES = {
  TENANT_ADMIN: 'TENANT_ADMIN',
  HR_MANAGER: 'HR_MANAGER',
  MANAGER: 'MANAGER',
  EMPLOYEE: 'EMPLOYEE',
} as const;

export type SystemRoleName = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/** Sensible defaults for the seeded system roles — all editable after seeding. */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleName, readonly PermissionKey[]> = {
  [SYSTEM_ROLES.TENANT_ADMIN]: ALL_PERMISSIONS,
  [SYSTEM_ROLES.HR_MANAGER]: [
    PERMISSIONS.EMPLOYEE_READ,
    PERMISSIONS.EMPLOYEE_WRITE,
    PERMISSIONS.PAYROLL_RUN,
    PERMISSIONS.SALARY_VIEW,
    PERMISSIONS.BRANCH_MANAGE,
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.COUNTRY_PACK_OVERRIDE_MANAGE,
    PERMISSIONS.WORKFLOW_PARTICIPATE,
    PERMISSIONS.WORKFLOW_MANAGE,
    PERMISSIONS.CUSTOM_FIELD_MANAGE,
    PERMISSIONS.LEAVE_READ,
    PERMISSIONS.LEAVE_WRITE,
    PERMISSIONS.LEAVE_APPROVE,
    PERMISSIONS.ATTENDANCE_READ,
    PERMISSIONS.ATTENDANCE_WRITE,
    PERMISSIONS.ATTENDANCE_APPROVE,
    PERMISSIONS.ATTENDANCE_REGULARIZE,
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.PAYSLIP_VIEW,
    PERMISSIONS.PERFORMANCE_READ,
    PERMISSIONS.PERFORMANCE_WRITE,
    PERMISSIONS.PERFORMANCE_REVIEW,
    PERMISSIONS.PERFORMANCE_MANAGE,
    PERMISSIONS.RECRUITMENT_READ,
    PERMISSIONS.RECRUITMENT_WRITE,
    PERMISSIONS.RECRUITMENT_MANAGE,
    PERMISSIONS.ONBOARDING_MANAGE,
    PERMISSIONS.OFFBOARDING_MANAGE,
    PERMISSIONS.EXPENSE_READ,
    PERMISSIONS.EXPENSE_WRITE,
    PERMISSIONS.EXPENSE_MANAGE,
    PERMISSIONS.ASSET_READ,
    PERMISSIONS.ASSET_MANAGE,
    PERMISSIONS.HELPDESK_READ,
    PERMISSIONS.HELPDESK_WRITE,
    PERMISSIONS.HELPDESK_MANAGE,
    PERMISSIONS.ANNOUNCEMENT_READ,
    PERMISSIONS.ANNOUNCEMENT_MANAGE,
    PERMISSIONS.POLICY_READ,
    PERMISSIONS.POLICY_MANAGE,
    PERMISSIONS.LMS_READ,
    PERMISSIONS.LMS_ENROLL,
    PERMISSIONS.LMS_AUTHOR,
    PERMISSIONS.LMS_ASSIGN,
    PERMISSIONS.LMS_MANAGE,
    PERMISSIONS.MIGRATION_MANAGE,
    PERMISSIONS.BENEFITS_READ,
    PERMISSIONS.BENEFITS_ENROLL,
    PERMISSIONS.BENEFITS_MANAGE,
    PERMISSIONS.ESIGNATURE_REQUEST,
    PERMISSIONS.ESIGNATURE_MANAGE,
    PERMISSIONS.ESIGNATURE_SIGN,
  ],
  [SYSTEM_ROLES.MANAGER]: [
    PERMISSIONS.EMPLOYEE_READ,
    PERMISSIONS.EMPLOYEE_WRITE,
    PERMISSIONS.WORKFLOW_PARTICIPATE,
    PERMISSIONS.LEAVE_READ,
    PERMISSIONS.LEAVE_WRITE,
    PERMISSIONS.LEAVE_APPROVE,
    PERMISSIONS.ATTENDANCE_READ,
    PERMISSIONS.ATTENDANCE_WRITE,
    PERMISSIONS.ATTENDANCE_APPROVE,
    PERMISSIONS.ATTENDANCE_REGULARIZE,
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.PERFORMANCE_READ,
    PERMISSIONS.PERFORMANCE_WRITE,
    PERMISSIONS.PERFORMANCE_REVIEW,
    PERMISSIONS.RECRUITMENT_READ,
    PERMISSIONS.RECRUITMENT_WRITE,
    PERMISSIONS.EXPENSE_READ,
    PERMISSIONS.EXPENSE_WRITE,
    PERMISSIONS.ASSET_READ,
    PERMISSIONS.HELPDESK_READ,
    PERMISSIONS.HELPDESK_WRITE,
    PERMISSIONS.ANNOUNCEMENT_READ,
    PERMISSIONS.POLICY_READ,
    PERMISSIONS.LMS_READ,
    PERMISSIONS.LMS_ENROLL,
    PERMISSIONS.LMS_ASSIGN,
    PERMISSIONS.BENEFITS_READ,
    PERMISSIONS.BENEFITS_ENROLL,
    PERMISSIONS.ESIGNATURE_SIGN,
  ],
  [SYSTEM_ROLES.EMPLOYEE]: [
    PERMISSIONS.EMPLOYEE_READ,
    PERMISSIONS.WORKFLOW_PARTICIPATE,
    PERMISSIONS.LEAVE_READ,
    PERMISSIONS.LEAVE_WRITE,
    PERMISSIONS.ATTENDANCE_READ,
    PERMISSIONS.ATTENDANCE_WRITE,
    PERMISSIONS.ATTENDANCE_REGULARIZE,
    PERMISSIONS.PERFORMANCE_READ,
    PERMISSIONS.PERFORMANCE_WRITE,
    PERMISSIONS.PERFORMANCE_REVIEW,
    PERMISSIONS.EXPENSE_READ,
    PERMISSIONS.EXPENSE_WRITE,
    PERMISSIONS.ASSET_READ,
    PERMISSIONS.HELPDESK_READ,
    PERMISSIONS.HELPDESK_WRITE,
    PERMISSIONS.ANNOUNCEMENT_READ,
    PERMISSIONS.POLICY_READ,
    PERMISSIONS.LMS_READ,
    PERMISSIONS.LMS_ENROLL,
    PERMISSIONS.BENEFITS_READ,
    PERMISSIONS.BENEFITS_ENROLL,
    PERMISSIONS.ESIGNATURE_SIGN,
  ],
};
