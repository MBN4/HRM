import { CERTIFICATION_EXPIRY_REMINDER_WINDOW_DAYS } from './lms.constants';

export type ComplianceBucket = 'COMPLIANT' | 'EXPIRING' | 'EXPIRED' | 'MISSING';

export interface CertLike {
  status: 'ACTIVE' | 'EXPIRED' | 'RENEWED';
  expiresAt: Date | null;
}

/**
 * Pure classification function — shared by `LmsComplianceService`'s live
 * drill-down read AND `LmsRollupProcessor`'s precomputed rollup, so the two
 * can never disagree about what "expiring" means. `cert` should be the
 * MOST RECENTLY ISSUED non-RENEWED (ACTIVE/EXPIRED) certification for a
 * given employee+course, or undefined if none exists at all.
 */
export function determineComplianceBucket(cert: CertLike | undefined, today: Date): ComplianceBucket {
  if (!cert) {
    return 'MISSING';
  }
  if (cert.status === 'EXPIRED') {
    return 'EXPIRED';
  }
  if (!cert.expiresAt) {
    return 'COMPLIANT';
  }
  const daysUntilExpiry = Math.floor((cert.expiresAt.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (daysUntilExpiry < 0) {
    return 'EXPIRED';
  }
  if (daysUntilExpiry <= CERTIFICATION_EXPIRY_REMINDER_WINDOW_DAYS) {
    return 'EXPIRING';
  }
  return 'COMPLIANT';
}

/**
 * Resolves, for every employee, the set of courseIds `RequiredTraining`
 * makes mandatory for them — a plain OR-match across every active rule
 * (branch/role both null = tenant-wide; either populated narrows the
 * match), never a keyed lookup (see the schema's own doc comment on why
 * there's no unique constraint here).
 */
export function resolveRequiredCourseIdsByEmployee(
  employees: { id: string; branchId: string }[],
  requiredTrainings: { courseId: string; roleId: string | null; branchId: string | null }[],
  employeeRoleIds: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const employee of employees) {
    const roles = employeeRoleIds.get(employee.id) ?? new Set<string>();
    const courseIds = new Set<string>();
    for (const rule of requiredTrainings) {
      const branchMatches = !rule.branchId || rule.branchId === employee.branchId;
      const roleMatches = !rule.roleId || roles.has(rule.roleId);
      if (branchMatches && roleMatches) {
        courseIds.add(rule.courseId);
      }
    }
    if (courseIds.size > 0) {
      result.set(employee.id, courseIds);
    }
  }
  return result;
}
