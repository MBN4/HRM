import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { AttendanceDailySummary, Prisma } from '@hrm/db';
import { ATTENDANCE_SUMMARY_QUEUE } from '../../queue/queue.constants';
import { AttendanceDailySummaryResponseDto } from '../attendance-response.dto';

export interface AttendanceSummaryJobData {
  tenantId: string;
  /** ISO-8601 date string — Dates don't survive BullMQ's JSON serialization, so job data carries the wire format, parsed back to a Date in the processor. */
  workDate: string;
  branchId?: string;
  employeeId?: string;
}

export interface AttendanceSummaryReportFilters {
  employeeId?: string;
  branchId?: string;
  from?: Date;
  to?: Date;
}

const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: false,
};

const MAX_LIST_RESULTS = 200;

/**
 * The summary-computation job's PRODUCER side, plus the read side of the
 * precomputed reporting surface — see docs/conventions/attendance.md.
 * Mirrors 0.8's `NotificationsService`/1.2's `LeaveAccrualService` shape:
 * enqueue one job, return immediately, the actual per-employee aggregation
 * happens in `AttendanceSummaryProcessor`, off any request path. Fired
 * fire-and-forget (one employee, one day — cheap) after every clock-out, and
 * available as a manual `POST /attendance/summary/run` trigger for a
 * broader branch/tenant backfill — the SAME documented, accepted "not wired
 * to a real scheduler yet" tradeoff 0.7's escalation sweep and 1.2's
 * accrual job already take.
 */
@Injectable()
export class AttendanceSummaryService {
  constructor(@InjectQueue(ATTENDANCE_SUMMARY_QUEUE) private readonly queue: Queue<AttendanceSummaryJobData>) {}

  async enqueueRecompute(tenantId: string, workDate: Date, branchId?: string, employeeId?: string): Promise<void> {
    await this.queue.add('recompute', { tenantId, workDate: workDate.toISOString(), branchId, employeeId }, JOB_OPTIONS);
  }

  /**
   * Team/period reports read ONLY this precomputed table — never
   * `AttendanceRecord` directly — so a report over many employees/days
   * never hammers the primary with an unbounded aggregate scan (this
   * module's brief, "heavy reads must not hit the primary").
   */
  async report(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    canManageOthers: boolean,
    allowedBranchIds: string[] | null,
    filters: AttendanceSummaryReportFilters,
  ): Promise<AttendanceDailySummaryResponseDto[]> {
    const where: Prisma.AttendanceDailySummaryWhereInput = {};

    if (!canManageOthers) {
      const own = await tx.employee.findFirst({ where: { userId: callerUserId }, select: { id: true } });
      if (!own) {
        return [];
      }
      where.employeeId = own.id;
    } else {
      if (filters.branchId && allowedBranchIds && !allowedBranchIds.includes(filters.branchId)) {
        return [];
      }
      if (filters.branchId) {
        where.branchId = filters.branchId;
      } else if (allowedBranchIds) {
        where.branchId = { in: allowedBranchIds };
      }
      if (filters.employeeId) {
        where.employeeId = filters.employeeId;
      }
    }

    if (filters.from) {
      where.workDate = { ...(where.workDate as Prisma.DateTimeFilter), gte: filters.from };
    }
    if (filters.to) {
      where.workDate = { ...(where.workDate as Prisma.DateTimeFilter), lte: filters.to };
    }

    const rows = await tx.attendanceDailySummary.findMany({ where, orderBy: { workDate: 'desc' }, take: MAX_LIST_RESULTS });
    return rows.map(toSummaryDto);
  }
}

function toSummaryDto(row: AttendanceDailySummary): AttendanceDailySummaryResponseDto {
  return new AttendanceDailySummaryResponseDto({
    id: row.id,
    employeeId: row.employeeId,
    branchId: row.branchId,
    workDate: row.workDate.toISOString(),
    status: row.status,
    workedMinutes: row.workedMinutes,
    overtimeMinutes: row.overtimeMinutes,
    lateMinutes: row.lateMinutes,
    computedAt: row.computedAt.toISOString(),
  });
}
