import { Injectable } from '@nestjs/common';
import type { Prisma, ShiftDefinition } from '@hrm/db';
import { addUtcDays, resolveWorkDate, toBranchLocal } from '../attendance-timezone.util';

export interface ClockInShiftResolution {
  shift: ShiftDefinition | null;
  /** The BRANCH-LOCAL working day this clock-in is attributed to — see docs/conventions/attendance.md. */
  workDate: Date;
}

/**
 * Resolves shifts/rosters — see docs/conventions/attendance.md. "Most
 * recent assignment whose range covers this date wins", the same
 * "most specific/most recent" resolution shape used elsewhere in this
 * schema (analogous to CountryPack's highest-version-active pick, 0.5),
 * rather than requiring non-overlapping assignments to be enforced at
 * write time.
 */
@Injectable()
export class ShiftResolutionService {
  async resolveForDate(tx: Prisma.TransactionClient, employeeId: string, calendarDate: Date): Promise<ShiftDefinition | null> {
    const assignment = await tx.rosterAssignment.findFirst({
      where: {
        employeeId,
        effectiveFrom: { lte: calendarDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: calendarDate } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!assignment) {
      return null;
    }
    return tx.shiftDefinition.findUnique({ where: { id: assignment.shiftDefinitionId } });
  }

  /**
   * The clock-in-time resolution that actually decides `workDate` — checks
   * YESTERDAY's roster (in branch-local terms) FIRST, via the same
   * `resolveWorkDate` primitive used everywhere else: if yesterday's shift
   * crosses midnight and the clock-in's local time-of-day falls before that
   * shift's end time, this clock-in is the tail end of a shift that started
   * yesterday, so `workDate` is yesterday and THAT is the shift snapshotted
   * on the record — not whatever (possibly different, possibly absent) shift
   * is separately rostered for today. Only when that doesn't apply does
   * today's own roster resolve normally. This two-step lookup is what
   * correctly handles a SINGLE-DAY roster assignment for a crossing-midnight
   * shift (a multi-day continuous assignment would resolve the same shift
   * either way, but a one-day assignment would otherwise be missed by
   * looking up "today" alone).
   */
  async resolveForClockIn(
    tx: Prisma.TransactionClient,
    employeeId: string,
    clockInAt: Date,
    timeZone: string,
  ): Promise<ClockInShiftResolution> {
    const local = toBranchLocal(clockInAt, timeZone);
    const yesterday = addUtcDays(local.calendarDate, -1);

    const shiftYesterday = await this.resolveForDate(tx, employeeId, yesterday);
    if (shiftYesterday && resolveWorkDate(clockInAt, timeZone, shiftYesterday).getTime() === yesterday.getTime()) {
      return { shift: shiftYesterday, workDate: yesterday };
    }

    const shiftToday = await this.resolveForDate(tx, employeeId, local.calendarDate);
    return { shift: shiftToday, workDate: local.calendarDate };
  }
}
