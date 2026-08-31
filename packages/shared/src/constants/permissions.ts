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
  ],
  [SYSTEM_ROLES.EMPLOYEE]: [
    PERMISSIONS.EMPLOYEE_READ,
    PERMISSIONS.WORKFLOW_PARTICIPATE,
    PERMISSIONS.LEAVE_READ,
    PERMISSIONS.LEAVE_WRITE,
    PERMISSIONS.ATTENDANCE_READ,
    PERMISSIONS.ATTENDANCE_WRITE,
    PERMISSIONS.ATTENDANCE_REGULARIZE,
  ],
};
