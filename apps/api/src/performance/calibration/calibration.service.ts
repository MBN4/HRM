import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';

export interface CalibrationRow {
  branchId: string;
  departmentId: string | null;
  ratingValue: number;
  employeeCount: number;
}

/**
 * The calibration/distribution READ side — reads ONLY
 * `AppraisalRatingDistributionSnapshot`, the pre-computed rollup
 * `CalibrationProcessor` maintains — NEVER live-aggregates `Appraisal`
 * directly, the same "cheap indexed reads over small pre-aggregated rows"
 * discipline `AnalyticsDashboardService` already establishes (see
 * docs/conventions/analytics-dashboard.md). Branch scoping is the SAME
 * two-layer shape: `allowedBranchIds` narrows the query for a restricted
 * caller; an explicit out-of-scope `branchId` returns empty, never a 403.
 */
@Injectable()
export class CalibrationService {
  async getDistribution(
    tx: Prisma.TransactionClient,
    cycleId: string,
    allowedBranchIds: string[] | null,
    branchId?: string,
  ): Promise<CalibrationRow[]> {
    if (branchId && allowedBranchIds && !allowedBranchIds.includes(branchId)) {
      return [];
    }
    const where: Prisma.AppraisalRatingDistributionSnapshotWhereInput = { cycleId };
    if (branchId) {
      where.branchId = branchId;
    } else if (allowedBranchIds) {
      where.branchId = { in: allowedBranchIds };
    }

    const rows = await tx.appraisalRatingDistributionSnapshot.findMany({ where, orderBy: { ratingValue: 'asc' } });
    return rows.map((row) => ({
      branchId: row.branchId,
      departmentId: row.departmentId,
      ratingValue: row.ratingValue,
      employeeCount: row.employeeCount,
    }));
  }
}
