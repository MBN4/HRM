import { Injectable } from '@nestjs/common';
import type { Employee, Prisma, RosterAssignment } from '@hrm/db';
import { shiftToWorkingHours, WEEKDAYS, type RosterGridQuery } from '@hrm/shared';
import { resolveAttendancePackConfig } from '../attendance/attendance-country-pack.util';
import { pickRosterAssignment } from '../attendance/shifts/roster-pick.util';
import { isPublicHoliday } from '../attendance/summary/attendance-day-status.util';
import {
  StandingInfo,
  WorkingHoursResolverService,
} from '../working-hours/working-hours-resolver.service';
import { eachYmd, parseYmd, scheduleDay } from './scheduling-day.util';
import { SchedulingActor, SchedulingScopeService } from './scheduling-scope.service';

/**
 * The roster calendar's data (step 8.2): who is on which shift on which date, for a team and a
 * window — plus the coverage view derived from the SAME data. Built to be a fixed handful of
 * queries regardless of team size or window length (never per employee / per day): one employee
 * list, ONE batch standing resolution (`resolveStandingBatch`), one roster query, one leave
 * query, one pack read per distinct BRANCH, then in-memory work. See docs/conventions/shift-scheduling.md.
 */
@Injectable()
export class RosterGridService {
  constructor(
    private readonly scope: SchedulingScopeService,
    private readonly workingHours: WorkingHoursResolverService,
  ) {}

  async grid(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    q: RosterGridQuery,
  ) {
    const data = await this.load(tx, tenantId, actor, q);
    return {
      from: q.from,
      to: q.to,
      days: data.days,
      canDefineShifts: actor.tenantWide,
      shifts: data.shifts.map((s) => ({
        id: s.id,
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        crossesMidnight: s.crossesMidnight,
        color: s.color,
        requiredHours: shiftToWorkingHours(s).requiredHours,
        minStaffing: s.minStaffing,
      })),
      branches: data.branches,
      employees: data.employees.map((e) => {
        const standing = data.standing.get(e.id) as StandingInfo;
        return {
          id: e.id,
          code: e.employeeCode,
          name: `${e.firstName} ${e.lastName}`,
          branchId: e.branchId,
          departmentId: e.departmentId,
          departmentName: e.departmentId ? (data.departmentName.get(e.departmentId) ?? null) : null,
          hasLogin: !!e.userId,
          standing: {
            source: standing.source,
            shiftId: standing.shift?.id ?? null,
            startTime: standing.policy?.startTime ?? null,
            requiredHours: standing.policy?.requiredHours ?? null,
          },
        };
      }),
      cells: data.cells,
      leave: data.leave,
    };
  }

  async coverage(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    q: RosterGridQuery,
  ) {
    const data = await this.load(tx, tenantId, actor, q);
    const nameOf = new Map(data.employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
    const cellKey = (employeeId: string, date: string) => `${employeeId}|${date}`;
    const cellOf = new Map(data.cells.map((c) => [cellKey(c.employeeId, c.date), c]));
    const leaveSet = new Set(data.leave.map((l) => cellKey(l.employeeId, l.date)));

    const days = data.days.map((date) => {
      const byShift = new Map<
        string,
        {
          employeeId: string;
          name: string;
          via: 'ROSTER' | 'STANDING';
          status: 'DRAFT' | 'PUBLISHED';
        }[]
      >();
      const defaultHours: string[] = [];
      const off: string[] = [];
      const onLeave: string[] = [];
      let workingDay = false;

      for (const e of data.employees) {
        const branch = data.branches[e.branchId];
        const cell = cellOf.get(cellKey(e.id, date)) ?? null;
        const d = scheduleDay({
          cell: cell ? { dayOff: cell.dayOff, shiftDefinitionId: cell.shiftId } : null,
          standingShiftId: (data.standing.get(e.id) as StandingInfo).shift?.id ?? null,
          isWeekend: !!branch?.weekendDays.includes(weekdayName(date)),
          isHoliday: !!branch?.holidays.includes(date),
          onLeave: leaveSet.has(cellKey(e.id, date)),
        });
        if (d.kind !== 'WEEKEND' && d.kind !== 'HOLIDAY') workingDay = true;
        if (d.kind === 'SHIFT' && d.shiftId) {
          byShift.set(d.shiftId, [
            ...(byShift.get(d.shiftId) ?? []),
            {
              employeeId: e.id,
              name: nameOf.get(e.id) as string,
              via: d.via as 'ROSTER' | 'STANDING',
              status: cell?.status ?? 'PUBLISHED',
            },
          ]);
        } else if (d.kind === 'DEFAULT_HOURS') defaultHours.push(e.id);
        else if (d.kind === 'LEAVE') onLeave.push(e.id);
        else off.push(e.id);
      }

      const shifts = data.shifts
        .filter((s) => byShift.has(s.id) || s.minStaffing)
        .map((s) => {
          const people = byShift.get(s.id) ?? [];
          // A gap is only meaningful on a day somebody actually works.
          const gap = workingDay && s.minStaffing != null && people.length < s.minStaffing;
          return { shiftId: s.id, count: people.length, minStaffing: s.minStaffing, gap, people };
        });
      return {
        date,
        workingDay,
        shifts,
        defaultHours: defaultHours.length,
        defaultHoursPeople: defaultHours.map((id) => ({
          employeeId: id,
          name: nameOf.get(id) as string,
        })),
        off: off.length,
        onLeave: onLeave.length,
      };
    });

    return {
      from: q.from,
      to: q.to,
      shifts: data.shifts.map((s) => ({
        id: s.id,
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        color: s.color,
        minStaffing: s.minStaffing,
      })),
      headcount: data.employees.length,
      days,
      gaps: days.flatMap((d) =>
        d.shifts
          .filter((s) => s.gap)
          .map((s) => ({
            date: d.date,
            shiftId: s.shiftId,
            count: s.count,
            minStaffing: s.minStaffing,
          })),
      ),
    };
  }

  /** Shared loader — the single place the "fixed handful of queries" budget is spent. */
  private async load(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: SchedulingActor,
    q: RosterGridQuery,
  ) {
    const employees = await this.scope.listSchedulableEmployees(tx, actor, {
      departmentId: q.departmentId,
      branchId: q.branchId,
    });
    const ids = employees.map((e) => e.id);
    const from = parseYmd(q.from);
    const to = parseYmd(q.to);
    const days = eachYmd(q.from, q.to);

    const departmentIds = [
      ...new Set(employees.map((e) => e.departmentId).filter((d): d is string => !!d)),
    ];
    const branchIds = [...new Set(employees.map((e) => e.branchId))];

    const [shifts, standing, rosterRows, leaves, departments, branchRows] = await Promise.all([
      tx.shiftDefinition.findMany({ orderBy: [{ startTime: 'asc' }, { name: 'asc' }] }),
      this.workingHours.resolveStandingBatch(tx, employees),
      tx.rosterAssignment.findMany({
        where: {
          employeeId: { in: ids },
          effectiveFrom: { lte: to },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
        },
      }),
      tx.leaveRequest.findMany({
        where: {
          employeeId: { in: ids },
          status: 'APPROVED',
          startDate: { lte: to },
          endDate: { gte: from },
        },
        select: { employeeId: true, startDate: true, endDate: true },
      }),
      tx.department.findMany({
        where: { id: { in: departmentIds } },
        select: { id: true, name: true },
      }),
      tx.branch.findMany({
        where: { id: { in: branchIds } },
        select: { id: true, name: true, timezone: true },
      }),
    ]);

    // Weekend/holiday facts per BRANCH (the pack is per country; one read per distinct branch).
    const branches: Record<
      string,
      { name: string; timezone: string; weekendDays: string[]; holidays: string[] }
    > = {};
    for (const b of branchRows) {
      const pack = await resolveAttendancePackConfig(tx, tenantId, b.id);
      branches[b.id] = {
        name: b.name,
        timezone: b.timezone,
        weekendDays: [...pack.weekendDays],
        holidays: days.filter((d) => isPublicHoliday(parseYmd(d), pack.publicHolidays)),
      };
    }

    const rowsByEmployee = new Map<string, RosterAssignment[]>();
    for (const r of rosterRows)
      rowsByEmployee.set(r.employeeId, [...(rowsByEmployee.get(r.employeeId) ?? []), r]);

    const cells: {
      employeeId: string;
      date: string;
      shiftId: string | null;
      dayOff: boolean;
      status: 'DRAFT' | 'PUBLISHED';
      assignmentId: string;
      note: string | null;
      /** True when the day comes from a legacy multi-day range row rather than a one-day cell. */
      fromRange: boolean;
    }[] = [];
    for (const e of employees) {
      const rows = rowsByEmployee.get(e.id);
      if (!rows) continue;
      for (const date of days) {
        const pick = pickRosterAssignment(rows, parseYmd(date));
        if (pick) {
          cells.push({
            employeeId: e.id,
            date,
            shiftId: pick.shiftDefinitionId,
            dayOff: pick.dayOff,
            status: pick.status,
            assignmentId: pick.id,
            note: pick.note,
            fromRange:
              pick.effectiveTo === null ||
              pick.effectiveTo.getTime() !== pick.effectiveFrom.getTime(),
          });
        }
      }
    }

    const leave: { employeeId: string; date: string }[] = [];
    for (const l of leaves) {
      for (const date of days) {
        const t = parseYmd(date).getTime();
        if (t >= l.startDate.getTime() && t <= l.endDate.getTime())
          leave.push({ employeeId: l.employeeId, date });
      }
    }

    return {
      employees: employees as Employee[],
      shifts,
      standing,
      cells,
      leave,
      days,
      branches,
      departmentName: new Map(departments.map((d) => [d.id, d.name])),
    };
  }
}

const weekdayName = (date: string) => WEEKDAYS[parseYmd(date).getUTCDay()] as string;
