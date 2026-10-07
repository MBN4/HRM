import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { AttendanceStatusQuery } from '@hrm/shared';
import { WorkingHoursResolverService } from '../../working-hours/working-hours-resolver.service';
import { DbChainReader } from '../../workflow/approval-chain';
import { resolveAttendancePackConfig } from '../attendance-country-pack.util';
import { toBranchLocal } from '../attendance-timezone.util';
import { classifyDay, ClassifiedDay, DAY_STATUSES, DayStatus, eachDay } from './attendance-day-classifier';

export interface AttendanceStatusActor {
  userId: string;
  /** null = unrestricted. */
  branchIds: string[] | null;
  /** `working_hours.manage` (HR / admin / CEO): may read anyone in their branch scope. */
  canReadTenant: boolean;
  /** `attendance.approve` (managers): may read people in their own reporting chain. */
  canReadReports: boolean;
}

export interface AttendanceStatusResult {
  employeeId: string;
  from: string;
  to: string;
  timezone: string;
  policy: {
    startTime: string;
    workHours: number;
    breakHours: number;
    requiredHours: number;
    graceMinutes: number;
    halfDayThresholdHours: number;
    source: string;
  };
  days: ClassifiedDay[];
  summary: Record<DayStatus, number>;
}

const parseYmd = (s: string) => new Date(`${s}T00:00:00.000Z`);

/**
 * Attendance day-status classification (step 8.1, Part 2) — see
 * docs/conventions/attendance-status.md. COMPUTED ON READ from the resolved
 * Part-1 policy + the stored `AttendanceRecord`s; the colour is never stored, so
 * a policy / holiday / leave change is reflected immediately and history can
 * never disagree with the rules. A range costs a fixed handful of queries
 * (employee, branch, pack, ONE policy resolution, records, leave) — never
 * per-day — so a month is cheap.
 */
@Injectable()
export class AttendanceStatusService {
  constructor(private readonly workingHours: WorkingHoursResolverService) {}

  async classifyRange(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: AttendanceStatusActor,
    query: AttendanceStatusQuery,
    now: Date = new Date(),
  ): Promise<AttendanceStatusResult> {
    const employee = await this.resolveTarget(tx, actor, query.employeeId);
    const from = parseYmd(query.from);
    const to = parseYmd(query.to);

    const effective = await this.workingHours.resolve(tx, tenantId, employee.id, query.from);
    const pack = await resolveAttendancePackConfig(tx, tenantId, employee.branchId);

    const [records, leaves] = await Promise.all([
      tx.attendanceRecord.findMany({
        where: { employeeId: employee.id, workDate: { gte: from, lte: to } },
        select: { workDate: true, clockInAt: true, clockOutAt: true },
        orderBy: { clockInAt: 'asc' },
      }),
      tx.leaveRequest.findMany({
        where: { employeeId: employee.id, status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from } },
        select: { startDate: true, endDate: true },
      }),
    ]);

    const recordsByDay = new Map<string, { clockInAt: Date; clockOutAt: Date | null }[]>();
    for (const r of records) {
      const key = r.workDate.toISOString().slice(0, 10);
      recordsByDay.set(key, [...(recordsByDay.get(key) ?? []), { clockInAt: r.clockInAt, clockOutAt: r.clockOutAt }]);
    }
    const leaveDays = new Set<string>();
    for (const l of leaves) {
      for (const d of eachDay(l.startDate, l.endDate)) leaveDays.add(d.toISOString().slice(0, 10));
    }

    const today = toBranchLocal(now, effective.timezone).calendarDate;
    const terminatedLocal = employee.terminatedAt ? toBranchLocal(employee.terminatedAt, effective.timezone).calendarDate : null;

    const days = eachDay(from, to).map((date) => {
      const key = date.toISOString().slice(0, 10);
      return classifyDay({
        date,
        today,
        now,
        timeZone: effective.timezone,
        policy: {
          startTime: effective.policy.startTime,
          requiredHours: effective.policy.requiredHours,
          graceMinutes: effective.policy.graceMinutes,
          halfDayThresholdHours: effective.policy.halfDayThresholdHours,
        },
        policySource: effective.source,
        weekendDays: pack.weekendDays,
        publicHolidays: pack.publicHolidays,
        onApprovedLeave: leaveDays.has(key),
        employed: date >= employee.joinDate && (!terminatedLocal || date <= terminatedLocal),
        records: recordsByDay.get(key) ?? [],
      });
    });

    const summary = Object.fromEntries(DAY_STATUSES.map((s) => [s, 0])) as Record<DayStatus, number>;
    for (const d of days) summary[d.status] += 1;

    return {
      employeeId: employee.id,
      from: query.from,
      to: query.to,
      timezone: effective.timezone,
      policy: { ...effective.policy, source: effective.source },
      days,
      summary,
    };
  }

  /**
   * Own status always; otherwise HR/admin/CEO (`working_hours.manage`) within their
   * branch scope, or a manager (`attendance.approve`) for someone in their REPORTING
   * CHAIN (the 7.2 management hierarchy). Anything else is 403; another tenant's
   * employee simply doesn't exist (RLS).
   */
  private async resolveTarget(tx: Prisma.TransactionClient, actor: AttendanceStatusActor, employeeId?: string) {
    if (!employeeId) {
      const own = await tx.employee.findFirst({ where: { userId: actor.userId } });
      if (!own) throw new NotFoundException('You have no employee profile.');
      return own;
    }
    const target = await tx.employee.findUnique({ where: { id: employeeId } });
    if (!target) throw new NotFoundException(`Employee "${employeeId}" was not found.`);
    if (target.userId === actor.userId) return target;

    if (actor.branchIds && !actor.branchIds.includes(target.branchId)) {
      throw new NotFoundException(`Employee "${employeeId}" was not found.`);
    }
    if (actor.canReadTenant) return target;
    if (actor.canReadReports && (await this.isInReportingChain(tx, actor.userId, target))) return target;
    throw new ForbiddenException('You can only view your own attendance status, or that of people who report to you.');
  }

  /** Is `managerUserId` anywhere above the target in the management chain? */
  private async isInReportingChain(
    tx: Prisma.TransactionClient,
    managerUserId: string,
    target: { userId: string | null; managerId: string | null },
  ): Promise<boolean> {
    const reader = new DbChainReader(tx);
    let current: string | null = target.userId;
    if (!current && target.managerId) {
      // A target with no login: step up via their Employee manager first.
      const mgr = await tx.employee.findUnique({ where: { id: target.managerId }, select: { userId: true } });
      if (mgr?.userId === managerUserId) return true;
      current = mgr?.userId ?? null;
    }
    const seen = new Set<string>();
    for (let depth = 0; current && depth < 64 && !seen.has(current); depth += 1) {
      seen.add(current);
      const up = await reader.managerOf(current);
      if (up === managerUserId) return true;
      current = up;
    }
    return false;
  }
}
