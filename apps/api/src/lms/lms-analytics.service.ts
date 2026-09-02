import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';

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

/**
 * The dashboard read side — queries ONLY the two precomputed rollup tables
 * (`CourseCompletionDailySnapshot`/`TrainingComplianceDailySnapshot`),
 * NEVER `Enrollment`/`Certification`/`RequiredTraining` directly, the SAME
 * "reads never hit the primary" discipline `AnalyticsDashboardService`
 * established in 1.5 — see docs/conventions/analytics-dashboard.md.
 * "As of `to`" means the LATEST snapshot on/before that date (a
 * point-in-time cross-section, like `HeadcountDailySnapshot` — never
 * summed across days, which would double-count).
 */
@Injectable()
export class LmsAnalyticsService {
  async courseCompletion(
    tx: Prisma.TransactionClient,
    tenantId: string,
    allowedBranchIds: string[] | null,
    filters: { to: Date; branchId?: string; courseId?: string },
  ): Promise<CourseCompletionKpi[]> {
    const branchWhere = this.resolveBranchWhere(allowedBranchIds, filters.branchId);
    if (branchWhere === 'NONE') {
      return [];
    }
    const latest = await tx.courseCompletionDailySnapshot.aggregate({
      where: { tenantId, snapshotDate: { lte: filters.to }, branchId: branchWhere, courseId: filters.courseId },
      _max: { snapshotDate: true },
    });
    if (!latest._max.snapshotDate) {
      return [];
    }
    const rows = await tx.courseCompletionDailySnapshot.findMany({
      where: { tenantId, snapshotDate: latest._max.snapshotDate, branchId: branchWhere, courseId: filters.courseId },
    });
    return rows.map((row) => ({
      courseId: row.courseId,
      branchId: row.branchId,
      departmentId: row.departmentId,
      enrolledCount: row.enrolledCount,
      inProgressCount: row.inProgressCount,
      completedCount: row.completedCount,
    }));
  }

  async trainingCompliance(
    tx: Prisma.TransactionClient,
    tenantId: string,
    allowedBranchIds: string[] | null,
    filters: { to: Date; branchId?: string; courseId?: string },
  ): Promise<TrainingComplianceKpi[]> {
    const branchWhere = this.resolveBranchWhere(allowedBranchIds, filters.branchId);
    if (branchWhere === 'NONE') {
      return [];
    }
    const latest = await tx.trainingComplianceDailySnapshot.aggregate({
      where: { tenantId, snapshotDate: { lte: filters.to }, branchId: branchWhere, courseId: filters.courseId },
      _max: { snapshotDate: true },
    });
    if (!latest._max.snapshotDate) {
      return [];
    }
    const rows = await tx.trainingComplianceDailySnapshot.findMany({
      where: { tenantId, snapshotDate: latest._max.snapshotDate, branchId: branchWhere, courseId: filters.courseId },
    });
    return rows.map((row) => ({
      courseId: row.courseId,
      branchId: row.branchId,
      departmentId: row.departmentId,
      requiredCount: row.requiredCount,
      compliantCount: row.compliantCount,
      expiringCount: row.expiringCount,
      expiredCount: row.expiredCount,
      missingCount: row.missingCount,
    }));
  }

  private resolveBranchWhere(allowedBranchIds: string[] | null, branchId?: string): string | { in: string[] } | undefined | 'NONE' {
    if (branchId) {
      if (allowedBranchIds && !allowedBranchIds.includes(branchId)) {
        return 'NONE';
      }
      return branchId;
    }
    return allowedBranchIds ? { in: allowedBranchIds } : undefined;
  }
}
