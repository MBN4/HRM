import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { AttendanceDayStatus, Employee, Prisma } from '@hrm/db';
import { withTenantContext } from '@hrm/db';
import { ATTENDANCE_SUMMARY_QUEUE } from '../../queue/queue.constants';
import { resolveAttendancePackConfig } from '../attendance-country-pack.util';
import type { AttendanceSummaryJobData } from './attendance-summary.service';
import { isPublicHoliday, isWeekend } from './attendance-day-status.util';

/**
 * The summary-computation job's WORKER side — see docs/conventions/attendance.md
 * and `QueueModule`'s doc comment for the reusable BullMQ pattern this
 * instantiates. Runs entirely OUTSIDE any HTTP request — no
 * `TenantContextService` context exists here — so `tenantId` arrives as
 * explicit job data and every DB access opens its OWN `withTenantContext`
 * transaction, the SAME "context-less worker" posture `EmployeeImportProcessor`
 * (1.1) and `LeaveAccrualProcessor` (1.2) already established.
 *
 * A plain `upsert` per employee/day — NO separate idempotency layer is
 * needed here (unlike leave accrual's ADDITIVE running total): this is a
 * full RECOMPUTE of one day's totals from source data every time, so
 * re-running it for the same period is naturally idempotent (same inputs,
 * same output), never a double-count risk.
 */
@Processor(ATTENDANCE_SUMMARY_QUEUE)
export class AttendanceSummaryProcessor extends WorkerHost {
  async process(job: Job<AttendanceSummaryJobData>): Promise<void> {
    const { tenantId, branchId, employeeId } = job.data;
    const workDate = new Date(job.data.workDate);

    await withTenantContext(tenantId, async (tx: Prisma.TransactionClient) => {
      const where: Prisma.EmployeeWhereInput = { status: 'ACTIVE' };
      if (employeeId) {
        where.id = employeeId;
      } else if (branchId) {
        where.branchId = branchId;
      }
      const employees = await tx.employee.findMany({ where });

      for (const employee of employees) {
        await this.computeOne(tx, tenantId, employee, workDate);
      }
    });
  }

  private async computeOne(tx: Prisma.TransactionClient, tenantId: string, employee: Employee, workDate: Date): Promise<void> {
    const pack = await resolveAttendancePackConfig(tx, tenantId, employee.branchId);

    let status: AttendanceDayStatus;
    let workedMinutes = 0;
    let overtimeMinutes = 0;
    let lateMinutes = 0;

    if (isWeekend(workDate, pack.weekendDays)) {
      status = 'WEEKEND';
    } else if (isPublicHoliday(workDate, pack.publicHolidays)) {
      status = 'HOLIDAY';
    } else {
      const onApprovedLeave = await tx.leaveRequest.findFirst({
        where: { employeeId: employee.id, status: 'APPROVED', startDate: { lte: workDate }, endDate: { gte: workDate } },
        select: { id: true },
      });

      if (onApprovedLeave) {
        status = 'ON_LEAVE';
      } else {
        const records = await tx.attendanceRecord.findMany({ where: { employeeId: employee.id, workDate } });
        if (records.length === 0) {
          status = 'ABSENT';
        } else {
          workedMinutes = records.reduce((sum, record) => sum + (record.workedMinutes ?? 0), 0);
          overtimeMinutes = records.reduce((sum, record) => sum + record.overtimeMinutes, 0);
          lateMinutes = records.reduce((sum, record) => sum + record.lateMinutes, 0);
          status = lateMinutes > 0 ? 'LATE' : 'PRESENT';
        }
      }
    }

    await tx.attendanceDailySummary.upsert({
      where: { tenantId_employeeId_workDate: { tenantId, employeeId: employee.id, workDate } },
      update: { branchId: employee.branchId, status, workedMinutes, overtimeMinutes, lateMinutes, computedAt: new Date() },
      create: { tenantId, employeeId: employee.id, branchId: employee.branchId, workDate, status, workedMinutes, overtimeMinutes, lateMinutes },
    });
  }
}
