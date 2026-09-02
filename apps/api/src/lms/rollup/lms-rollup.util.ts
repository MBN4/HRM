import type { ComplianceBucket } from '../lms-compliance.util';

export function yesterdayUtc(): Date {
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return yesterday;
}

export function toUtcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export interface EnrollmentForRollup {
  branchId: string;
  departmentId: string | null;
  courseId: string;
  status: 'ENROLLED' | 'IN_PROGRESS' | 'COMPLETED';
}

export interface CourseCompletionRow {
  branchId: string;
  departmentId: string | null;
  courseId: string;
  enrolledCount: number;
  inProgressCount: number;
  completedCount: number;
}

/**
 * One row per (branchId, departmentId, courseId) — the SAME small-
 * dimension grouping discipline `analytics-rollup.util.ts` established in
 * 1.5. `enrolledCount` counts EVERY enrollment in the grain (all statuses),
 * matching how a dashboard would phrase "N employees enrolled in this
 * course".
 */
export function computeCourseCompletionRows(enrollments: EnrollmentForRollup[]): CourseCompletionRow[] {
  const byKey = new Map<string, CourseCompletionRow>();
  for (const enrollment of enrollments) {
    const key = `${enrollment.branchId}|${enrollment.departmentId ?? ''}|${enrollment.courseId}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        branchId: enrollment.branchId,
        departmentId: enrollment.departmentId,
        courseId: enrollment.courseId,
        enrolledCount: 0,
        inProgressCount: 0,
        completedCount: 0,
      };
      byKey.set(key, row);
    }
    row.enrolledCount += 1;
    if (enrollment.status === 'IN_PROGRESS') {
      row.inProgressCount += 1;
    } else if (enrollment.status === 'COMPLETED') {
      row.completedCount += 1;
    }
  }
  return [...byKey.values()];
}

export interface ComplianceEmployeeCoursePair {
  branchId: string;
  departmentId: string | null;
  courseId: string;
  bucket: ComplianceBucket;
}

export interface ComplianceRow {
  branchId: string;
  departmentId: string | null;
  courseId: string;
  requiredCount: number;
  compliantCount: number;
  expiringCount: number;
  expiredCount: number;
  missingCount: number;
}

/**
 * One row per (branchId, departmentId, courseId) — the compliance rollup.
 * Every `pair` is one (employee, required course) match, already
 * classified into a bucket by `determineComplianceBucket` — this function
 * does nothing but count, so the classification logic itself only exists
 * once (shared with `LmsComplianceService`'s live drill-down — see
 * lms-compliance.util.ts).
 */
export function computeComplianceRows(pairs: ComplianceEmployeeCoursePair[]): ComplianceRow[] {
  const byKey = new Map<string, ComplianceRow>();
  for (const pair of pairs) {
    const key = `${pair.branchId}|${pair.departmentId ?? ''}|${pair.courseId}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        branchId: pair.branchId,
        departmentId: pair.departmentId,
        courseId: pair.courseId,
        requiredCount: 0,
        compliantCount: 0,
        expiringCount: 0,
        expiredCount: 0,
        missingCount: 0,
      };
      byKey.set(key, row);
    }
    row.requiredCount += 1;
    if (pair.bucket === 'COMPLIANT') {
      row.compliantCount += 1;
    } else if (pair.bucket === 'EXPIRING') {
      row.expiringCount += 1;
    } else if (pair.bucket === 'EXPIRED') {
      row.expiredCount += 1;
    } else {
      row.missingCount += 1;
    }
  }
  return [...byKey.values()];
}
