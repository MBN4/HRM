import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { ANALYTICS_ROLLUP_QUEUE } from '../../queue/queue.constants';
import type { AnalyticsRollupJobData } from './analytics-rollup.service';
import { AnalyticsRollupService } from './analytics-rollup.service';
import {
  computeAttendanceBranchSummaryRows,
  computeHeadcountSnapshotRows,
  computeLeaveUtilizationRows,
  computeMovementRows,
  toUtcDateOnly,
} from './analytics-rollup.util';

/**
 * The rollup job's WORKER side — see docs/conventions/analytics-dashboard.md
 * and `AnalyticsRollupService`'s doc comment for the scheduling half. Two
 * job names share this one processor/queue:
 *
 * - `orchestrate` (no tenant context at all — fans out, doesn't compute
 *   anything itself) — fired by the repeatable schedule.
 * - `rollup-tenant` (`{ tenantId, date }`) — the SAME "context-less worker,
 *   own `withTenantContext` transaction" posture every Phase 1 processor
 *   already takes (`EmployeeImportProcessor`, `LeaveAccrualProcessor`,
 *   `AttendanceSummaryProcessor`). Computes all FOUR rollup tables for one
 *   tenant/one date in a single transaction: DELETE the existing rows for
 *   that (tenantId, date) grain, then one bulk `createMany` per table — see
 *   the schema doc comment on why this is delete+recreate, not upsert
 *   (nullable `departmentId` breaks unique-key upsert matching).
 */
@Processor(ANALYTICS_ROLLUP_QUEUE)
export class AnalyticsRollupProcessor extends WorkerHost {
  constructor(private readonly rollupService: AnalyticsRollupService) {
    super();
  }

  async process(job: Job<AnalyticsRollupJobData | Record<string, never>>): Promise<void> {
    if (job.name === 'orchestrate') {
      await this.rollupService.enqueueForEveryLiveTenant();
      return;
    }

    const { tenantId, date } = job.data as AnalyticsRollupJobData;
    const theDate = toUtcDateOnly(new Date(date));

    await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
      await this.rollHeadcount(tx, tenantId, theDate);
      await this.rollMovements(tx, tenantId, theDate);
      await this.rollAttendance(tx, tenantId, theDate);
      await this.rollLeaveUtilization(tx, tenantId, theDate);
    });
  }

  private async rollHeadcount(tx: Prisma.TransactionClient, tenantId: string, date: Date): Promise<void> {
    const employees = await tx.employee.findMany({
      where: { status: { in: ['ACTIVE', 'ON_LEAVE'] } },
      select: { branchId: true, departmentId: true, employmentType: true, gender: true },
    });
    const rows = computeHeadcountSnapshotRows(employees);

    await tx.headcountDailySnapshot.deleteMany({ where: { tenantId, snapshotDate: date } });
    if (rows.length > 0) {
      await tx.headcountDailySnapshot.createMany({
        data: rows.map((row) => ({ tenantId, snapshotDate: date, ...row })),
      });
    }
  }

  private async rollMovements(tx: Prisma.TransactionClient, tenantId: string, date: Date): Promise<void> {
    const employees = await tx.employee.findMany({
      select: { branchId: true, departmentId: true, joinDate: true, terminatedAt: true },
    });
    const rows = computeMovementRows(employees, date);

    await tx.workforceMovementDailyCount.deleteMany({ where: { tenantId, movementDate: date } });
    if (rows.length > 0) {
      await tx.workforceMovementDailyCount.createMany({
        data: rows.map((row) => ({ tenantId, movementDate: date, ...row })),
      });
    }
  }

  private async rollAttendance(tx: Prisma.TransactionClient, tenantId: string, date: Date): Promise<void> {
    const summaries = await tx.attendanceDailySummary.findMany({
      where: { workDate: date },
      select: {
        branchId: true,
        status: true,
        workedMinutes: true,
        overtimeMinutes: true,
        lateMinutes: true,
        employee: { select: { departmentId: true } },
      },
    });
    const rows = computeAttendanceBranchSummaryRows(
      summaries.map((summary) => ({
        branchId: summary.branchId,
        departmentId: summary.employee.departmentId,
        status: summary.status,
        workedMinutes: summary.workedMinutes,
        overtimeMinutes: summary.overtimeMinutes,
        lateMinutes: summary.lateMinutes,
      })),
    );

    await tx.attendanceDailyBranchSummary.deleteMany({ where: { tenantId, workDate: date } });
    if (rows.length > 0) {
      await tx.attendanceDailyBranchSummary.createMany({
        data: rows.map((row) => ({ tenantId, workDate: date, ...row })),
      });
    }
  }

  private async rollLeaveUtilization(tx: Prisma.TransactionClient, tenantId: string, date: Date): Promise<void> {
    const balances = await tx.leaveBalance.findMany({
      where: { periodYear: date.getUTCFullYear() },
      select: {
        leaveType: true,
        entitledDays: true,
        accruedDays: true,
        usedDays: true,
        employee: { select: { branchId: true, departmentId: true } },
      },
    });
    const rows = computeLeaveUtilizationRows(
      balances.map((balance) => ({
        branchId: balance.employee.branchId,
        departmentId: balance.employee.departmentId,
        leaveType: balance.leaveType,
        entitledDays: balance.entitledDays,
        accruedDays: balance.accruedDays,
        usedDays: balance.usedDays,
      })),
    );

    await tx.leaveUtilizationDailySnapshot.deleteMany({ where: { tenantId, snapshotDate: date } });
    if (rows.length > 0) {
      await tx.leaveUtilizationDailySnapshot.createMany({
        data: rows.map((row) => ({ tenantId, snapshotDate: date, ...row })),
      });
    }
  }
}
