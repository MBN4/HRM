/**
 * Precedent-duplicated subset of `@hrm/shared/src/constants/permissions.ts`'s
 * `PERMISSIONS` catalog — only the keys this ESS-only mobile app's UI ever
 * gates on. See src/constants/app.ts's doc comment for why this is a plain
 * duplicated literal rather than a cross-package import. Never used to
 * SEED roles (that stays server-side, `packages/db/src/seed-rbac.ts`) —
 * only to name the exact permission strings this app's screens check
 * against `GET /auth/me`'s live `permissions` array, the same
 * "RBAC gates the feature, drive UI off `permissions`, never a role
 * string" posture docs/conventions/auth-rbac.md documents.
 */
export const PERMISSIONS = {
  EMPLOYEE_READ: 'employee.read',
  EMPLOYEE_WRITE: 'employee.write',
  SALARY_VIEW: 'salary.view',
  WORKFLOW_PARTICIPATE: 'workflow.participate',
  LEAVE_READ: 'leave.read',
  LEAVE_WRITE: 'leave.write',
  ATTENDANCE_READ: 'attendance.read',
  ATTENDANCE_WRITE: 'attendance.write',
  ATTENDANCE_REGULARIZE: 'attendance.regularize',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
