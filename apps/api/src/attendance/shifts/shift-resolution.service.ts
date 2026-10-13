import { Injectable, Optional } from '@nestjs/common';
import type { Prisma, ShiftDefinition } from '@hrm/db';
import { WorkingHoursResolverService } from '../../working-hours/working-hours-resolver.service';
import { addUtcDays, resolveWorkDate, toBranchLocal } from '../attendance-timezone.util';
import { pickRosterAssignment } from './roster-pick.util';

export interface ClockInShiftResolution {
  shift: ShiftDefinition | null;
  /** The BRANCH-LOCAL working day this clock-in is attributed to — see docs/conventions/attendance.md. */
  workDate: Date;
}

/**
 * Resolves the shift that applies on a day — see docs/conventions/attendance.md and (for the
 * 8.2 reconciliation) docs/conventions/shift-scheduling.md:
 *
 *   published dated roster row (narrowest span, then latest start)  ??  standing shift
 *     (member > team > company, via WorkingHoursResolverService)  ??  null
 *
 * A rostered DAY OFF resolves to `null` (no shift) deliberately — it must not fall through to
 * the standing shift. DRAFT roster rows are invisible here: only a published roster is live.
 */
@Injectable()
export class ShiftResolutionService {
  constructor(@Optional() private readonly workingHours?: WorkingHoursResolverService) {}

  async resolveForDate(
    tx: Prisma.TransactionClient,
    employeeId: string,
    calendarDate: Date,
    /** A pre-resolved standing shift (undefined = look it up) — lets resolveForClockIn look it up once for its two days. */
    standing?: ShiftDefinition | null,
  ): Promise<ShiftDefinition | null> {
    const candidates = await tx.rosterAssignment.findMany({
      where: {
        employeeId,
        status: 'PUBLISHED',
        effectiveFrom: { lte: calendarDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: calendarDate } }],
      },
    });
    const assignment = pickRosterAssignment(candidates, calendarDate);
    if (assignment) {
      if (assignment.dayOff || !assignment.shiftDefinitionId) return null;
      return tx.shiftDefinition.findUnique({ where: { id: assignment.shiftDefinitionId } });
    }
    if (standing !== undefined) return standing;
    return (await this.workingHours?.standingShift(tx, employeeId)) ?? null;
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

    // The standing shift is the same for both days — look it up once.
    const standing = (await this.workingHours?.standingShift(tx, employeeId)) ?? null;

    const shiftYesterday = await this.resolveForDate(tx, employeeId, yesterday, standing);
    if (
      shiftYesterday &&
      resolveWorkDate(clockInAt, timeZone, shiftYesterday).getTime() === yesterday.getTime()
    ) {
      return { shift: shiftYesterday, workDate: yesterday };
    }

    const shiftToday = await this.resolveForDate(tx, employeeId, local.calendarDate, standing);
    return { shift: shiftToday, workDate: local.calendarDate };
  }
}
