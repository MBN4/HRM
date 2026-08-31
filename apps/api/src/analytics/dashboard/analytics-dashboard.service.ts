import { Injectable } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import { AnalyticsDashboardResponseDto } from './analytics-dashboard.dto';

export interface AnalyticsDashboardFilters {
  branchId?: string;
  departmentId?: string;
  from: Date;
  to: Date;
}

/**
 * The dashboard READ side — see docs/conventions/analytics-dashboard.md.
 * Reads ONLY the four rollup tables computed by `AnalyticsRollupProcessor`
 * (`HeadcountDailySnapshot`/`WorkforceMovementDailyCount`/
 * `AttendanceDailyBranchSummary`/`LeaveUtilizationDailySnapshot`) — NEVER
 * `Employee`/`AttendanceRecord`/`LeaveRequest`/`LeaveBalance` directly. This
 * is the whole point of the module: a dashboard load is a handful of cheap,
 * indexed reads over small pre-aggregated rows, not a live scan over any
 * high-volume table, no matter how many employees the tenant has — see
 * `apps/api/test/analytics.e2e-spec.ts`'s query-log assertion, which proves
 * this directly rather than just trusting the code.
 *
 * Branch scoping is the SAME two-layer shape `AttendanceSummaryService.
 * report` already establishes: `allowedBranchIds` narrows every query for a
 * restricted caller; an explicit `branchId` filter outside that scope
 * returns an all-zero/empty dashboard, never a 403 (RBAC — `analytics.read`
 * — gates the FEATURE at the controller; this gates the ROW).
 */
@Injectable()
export class AnalyticsDashboardService {
  async getDashboard(
    tx: Prisma.TransactionClient,
    allowedBranchIds: string[] | null,
    filters: AnalyticsDashboardFilters,
  ): Promise<AnalyticsDashboardResponseDto> {
    const { from, to } = filters;
    const branchScope = this.resolveBranchScope(allowedBranchIds, filters.branchId);

    if (branchScope.outOfScope) {
      return this.emptyDashboard(from, to);
    }

    const branchWhere = branchScope.branchIds ? { branchId: { in: branchScope.branchIds } } : {};
    const deptWhere = filters.departmentId ? { departmentId: filters.departmentId } : {};

    const [headcount, movement, attendance, leave] = await Promise.all([
      this.readHeadcount(tx, to, branchWhere, deptWhere),
      this.readMovement(tx, from, to, branchWhere, deptWhere),
      this.readAttendance(tx, from, to, branchWhere, deptWhere),
      this.readLeaveUtilization(tx, from, to, branchWhere, deptWhere),
    ]);

    const totalHeadcount = sum(headcount.byBranch.map((r) => r.count));

    return new AnalyticsDashboardResponseDto({
      range: { from: from.toISOString(), to: to.toISOString() },
      headcount: { ...headcount, total: totalHeadcount },
      movement: { ...movement, attritionRate: rate(movement.leavers, totalHeadcount) },
      attendance,
      leave,
    });
  }

  private resolveBranchScope(
    allowedBranchIds: string[] | null,
    requestedBranchId?: string,
  ): { outOfScope: boolean; branchIds: string[] | null } {
    if (requestedBranchId) {
      if (allowedBranchIds && !allowedBranchIds.includes(requestedBranchId)) {
        return { outOfScope: true, branchIds: null };
      }
      return { outOfScope: false, branchIds: [requestedBranchId] };
    }
    return { outOfScope: false, branchIds: allowedBranchIds };
  }

  private emptyDashboard(from: Date, to: Date): AnalyticsDashboardResponseDto {
    return new AnalyticsDashboardResponseDto({
      range: { from: from.toISOString(), to: to.toISOString() },
      headcount: { asOfDate: null, total: 0, byBranch: [], byDepartment: [], byEmploymentType: [], byGender: [] },
      movement: { joiners: 0, leavers: 0, attritionRate: 0, byBranch: [] },
      attendance: {
        presentCount: 0,
        absentCount: 0,
        lateCount: 0,
        onLeaveCount: 0,
        weekendCount: 0,
        holidayCount: 0,
        employeeDays: 0,
        attendanceRate: 0,
        trend: [],
      },
      leave: { byType: [] },
    });
  }

  private async readHeadcount(
    tx: Prisma.TransactionClient,
    to: Date,
    branchWhere: Prisma.HeadcountDailySnapshotWhereInput,
    deptWhere: Prisma.HeadcountDailySnapshotWhereInput,
  ) {
    const latest = await tx.headcountDailySnapshot.aggregate({
      where: { snapshotDate: { lte: to }, ...branchWhere, ...deptWhere },
      _max: { snapshotDate: true },
    });
    const asOfDate = latest._max.snapshotDate;
    if (!asOfDate) {
      return { asOfDate: null, byBranch: [], byDepartment: [], byEmploymentType: [], byGender: [] };
    }

    const rows = await tx.headcountDailySnapshot.findMany({ where: { snapshotDate: asOfDate, ...branchWhere, ...deptWhere } });

    return {
      asOfDate: asOfDate.toISOString(),
      byBranch: sumByKey(rows, (r) => r.branchId, (r) => r.activeCount).map(([branchId, count]) => ({ branchId, count })),
      byDepartment: sumByKey(rows, (r) => r.departmentId, (r) => r.activeCount).map(([departmentId, count]) => ({
        departmentId: departmentId === NULL_KEY ? null : departmentId,
        count,
      })),
      byEmploymentType: sumByKey(rows, (r) => r.employmentType, (r) => r.activeCount).map(([employmentType, count]) => ({
        employmentType,
        count,
      })),
      byGender: sumByKey(rows, (r) => r.gender, (r) => r.activeCount).map(([gender, count]) => ({
        gender: gender === NULL_KEY ? null : gender,
        count,
      })),
    };
  }

  private async readMovement(
    tx: Prisma.TransactionClient,
    from: Date,
    to: Date,
    branchWhere: Prisma.WorkforceMovementDailyCountWhereInput,
    deptWhere: Prisma.WorkforceMovementDailyCountWhereInput,
  ) {
    const rows = await tx.workforceMovementDailyCount.findMany({
      where: { movementDate: { gte: from, lte: to }, ...branchWhere, ...deptWhere },
    });

    const joiners = sum(rows.filter((r) => r.movementType === 'JOINER').map((r) => r.count));
    const leavers = sum(rows.filter((r) => r.movementType === 'LEAVER').map((r) => r.count));

    const byBranch = new Map<string, { branchId: string; joiners: number; leavers: number }>();
    for (const row of rows) {
      const entry = byBranch.get(row.branchId) ?? { branchId: row.branchId, joiners: 0, leavers: 0 };
      if (row.movementType === 'JOINER') entry.joiners += row.count;
      else entry.leavers += row.count;
      byBranch.set(row.branchId, entry);
    }

    return { joiners, leavers, byBranch: [...byBranch.values()] };
  }

  private async readAttendance(
    tx: Prisma.TransactionClient,
    from: Date,
    to: Date,
    branchWhere: Prisma.AttendanceDailyBranchSummaryWhereInput,
    deptWhere: Prisma.AttendanceDailyBranchSummaryWhereInput,
  ) {
    const rows = await tx.attendanceDailyBranchSummary.findMany({
      where: { workDate: { gte: from, lte: to }, ...branchWhere, ...deptWhere },
      orderBy: { workDate: 'asc' },
    });

    const presentCount = sum(rows.map((r) => r.presentCount));
    const absentCount = sum(rows.map((r) => r.absentCount));
    const lateCount = sum(rows.map((r) => r.lateCount));
    const onLeaveCount = sum(rows.map((r) => r.onLeaveCount));
    const weekendCount = sum(rows.map((r) => r.weekendCount));
    const holidayCount = sum(rows.map((r) => r.holidayCount));
    const employeeDays = sum(rows.map((r) => r.employeeCount));

    const byDate = new Map<string, { date: string; presentCount: number; absentCount: number; lateCount: number; employeeCount: number }>();
    for (const row of rows) {
      const date = row.workDate.toISOString();
      const entry = byDate.get(date) ?? { date, presentCount: 0, absentCount: 0, lateCount: 0, employeeCount: 0 };
      entry.presentCount += row.presentCount;
      entry.absentCount += row.absentCount;
      entry.lateCount += row.lateCount;
      entry.employeeCount += row.employeeCount;
      byDate.set(date, entry);
    }

    return {
      presentCount,
      absentCount,
      lateCount,
      onLeaveCount,
      weekendCount,
      holidayCount,
      employeeDays,
      attendanceRate: rate(presentCount, employeeDays),
      trend: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  private async readLeaveUtilization(
    tx: Prisma.TransactionClient,
    from: Date,
    to: Date,
    branchWhere: Prisma.LeaveUtilizationDailySnapshotWhereInput,
    deptWhere: Prisma.LeaveUtilizationDailySnapshotWhereInput,
  ) {
    const toMax = await tx.leaveUtilizationDailySnapshot.aggregate({
      where: { snapshotDate: { lte: to }, ...branchWhere, ...deptWhere },
      _max: { snapshotDate: true },
    });
    const toRows = toMax._max.snapshotDate
      ? await tx.leaveUtilizationDailySnapshot.findMany({ where: { snapshotDate: toMax._max.snapshotDate, ...branchWhere, ...deptWhere } })
      : [];

    // Strictly BEFORE `from` — so the baseline excludes `from`'s own day, and the delta below includes every day in [from, to].
    const fromMax = await tx.leaveUtilizationDailySnapshot.aggregate({
      where: { snapshotDate: { lt: from }, ...branchWhere, ...deptWhere },
      _max: { snapshotDate: true },
    });
    const fromRows = fromMax._max.snapshotDate
      ? await tx.leaveUtilizationDailySnapshot.findMany({ where: { snapshotDate: fromMax._max.snapshotDate, ...branchWhere, ...deptWhere } })
      : [];

    const entitledByType = sumByKey(toRows, (r) => r.leaveType, (r) => r.totalEntitledDays);
    const usedToDateByType = sumByKey(toRows, (r) => r.leaveType, (r) => r.totalUsedDays);
    const baselineUsedByType = new Map(sumByKey(fromRows, (r) => r.leaveType, (r) => r.totalUsedDays));

    const byType = entitledByType.map(([leaveType, entitledDays]) => {
      const usedToDate = usedToDateByType.find(([type]) => type === leaveType)?.[1] ?? 0;
      const usedInPeriod = usedToDate - (baselineUsedByType.get(leaveType) ?? 0);
      return { leaveType, entitledDays, usedToDate, usedInPeriod, utilizationRate: rate(usedToDate, entitledDays) };
    });

    return { byType };
  }
}

const NULL_KEY = '__NULL__';

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Groups `rows` by `keyOf(row)` (null coalesced to a sentinel so it survives being a Map key) and sums `valueOf(row)` per group. */
function sumByKey<T, K extends string | null>(rows: T[], keyOf: (row: T) => K, valueOf: (row: T) => number): [string, number][] {
  const grouped = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row) ?? NULL_KEY;
    grouped.set(key, (grouped.get(key) ?? 0) + valueOf(row));
  }
  return [...grouped.entries()];
}
