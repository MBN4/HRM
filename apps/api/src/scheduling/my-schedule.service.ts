import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@hrm/db';
import type { MyScheduleQuery } from '@hrm/shared';
import { resolveAttendancePackConfig } from '../attendance/attendance-country-pack.util';
import { toBranchLocal } from '../attendance/attendance-timezone.util';
import { isPublicHoliday, isWeekend } from '../attendance/summary/attendance-day-status.util';
import { WorkingHoursResolverService } from '../working-hours/working-hours-resolver.service';
import { addDaysYmd, eachYmd, parseYmd, scheduleDay, ymd } from './scheduling-day.util';

const DEFAULT_WINDOW_DAYS = 14;

/**
 * "My schedule" (step 8.2): the caller's OWN upcoming days, from the same resolver the attendance
 * classification uses — so what an employee is shown is exactly what they will be judged against.
 * Only PUBLISHED roster cells exist as far as the resolver is concerned; a draft is invisible here.
 * Uses `resolveRange` (one standing resolution + one roster query for the whole window).
 */
@Injectable()
export class MyScheduleService {
  constructor(private readonly workingHours: WorkingHoursResolverService) {}

  async mine(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    q: MyScheduleQuery,
    now: Date = new Date(),
  ) {
    const employee = await tx.employee.findFirst({ where: { userId } });
    if (!employee) throw new NotFoundException('You have no employee profile.');

    const branch = await tx.branch.findUniqueOrThrow({
      where: { id: employee.branchId },
      select: { timezone: true, name: true },
    });
    const today = ymd(toBranchLocal(now, branch.timezone).calendarDate);
    const from = q.from ?? today;
    const to = q.to ?? addDaysYmd(from, DEFAULT_WINDOW_DAYS - 1);

    const [range, pack, leaves, swaps] = await Promise.all([
      this.workingHours.resolveRange(tx, tenantId, employee.id, parseYmd(from), parseYmd(to)),
      resolveAttendancePackConfig(tx, tenantId, employee.branchId),
      tx.leaveRequest.findMany({
        where: {
          employeeId: employee.id,
          status: 'APPROVED',
          startDate: { lte: parseYmd(to) },
          endDate: { gte: parseYmd(from) },
        },
        select: { startDate: true, endDate: true },
      }),
      tx.shiftSwapRequest.findMany({
        where: {
          date: { gte: parseYmd(from), lte: parseYmd(to) },
          status: { in: ['AWAITING_PEER', 'PENDING_APPROVAL'] },
          OR: [{ requesterEmployeeId: employee.id }, { counterpartEmployeeId: employee.id }],
        },
        select: { id: true, date: true, status: true, requesterEmployeeId: true },
      }),
    ]);
    const leaveDays = new Set<string>();
    for (const l of leaves)
      for (const d of eachYmd(ymd(l.startDate), ymd(l.endDate))) leaveDays.add(d);
    const swapByDate = new Map(
      swaps.map((s) => [
        ymd(s.date),
        { id: s.id, status: s.status, mine: s.requesterEmployeeId === employee.id },
      ]),
    );

    const days = eachYmd(from, to).map((date) => {
      const d = parseYmd(date);
      const eff = range.forDate(d);
      const cellShift = eff.rostered && !eff.dayOff ? eff.shift : null;
      const kind = scheduleDay({
        cell: eff.rostered
          ? { dayOff: eff.dayOff, shiftDefinitionId: cellShift?.id ?? null }
          : null,
        standingShiftId: eff.rostered ? null : (eff.shift?.id ?? null),
        isWeekend: isWeekend(d, pack.weekendDays),
        isHoliday: isPublicHoliday(d, pack.publicHolidays),
        onLeave: leaveDays.has(date),
      });
      const shift = kind.kind === 'SHIFT' || kind.kind === 'LEAVE' ? eff.shift : null;
      return {
        date,
        kind: kind.kind,
        via: kind.via,
        shift,
        startTime:
          kind.kind === 'SHIFT' || kind.kind === 'DEFAULT_HOURS' ? eff.policy.startTime : null,
        requiredHours:
          kind.kind === 'SHIFT' || kind.kind === 'DEFAULT_HOURS' ? eff.policy.requiredHours : null,
        swap: swapByDate.get(date) ?? null,
      };
    });

    return { employeeId: employee.id, timezone: branch.timezone, today, from, to, days };
  }
}
