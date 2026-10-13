import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, ShiftDefinition, WorkingHoursPolicy } from '@hrm/db';
import {
  defaultHalfDayThreshold,
  requiredHoursOf,
  shiftToWorkingHours,
  WORKING_HOURS_DEFAULTS,
  type WorkingHoursSource,
} from '@hrm/shared';
import { resolveAttendancePackConfig } from '../attendance/attendance-country-pack.util';
import { pickRosterAssignment } from '../attendance/shifts/roster-pick.util';

export interface EffectiveShiftInfo {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  color: string | null;
}

export interface EffectivePolicyValues {
  startTime: string;
  workHours: number;
  breakHours: number;
  requiredHours: number;
  graceMinutes: number;
  halfDayThresholdHours: number;
  /** True when the threshold was derived (requiredHours / 2) rather than set. */
  halfDayThresholdDerived: boolean;
}

/** The resolved schedule — what day-status classification, the attendance graph and "my schedule" consume. */
export interface EffectiveWorkingHours {
  employeeId: string;
  branchId: string;
  /** The member's BRANCH timezone (IANA) — never stored on a policy or a shift. */
  timezone: string;
  /** Echo of the requested date (YYYY-MM-DD) or null when none was asked for. */
  date: string | null;
  policy: EffectivePolicyValues;
  /** Which layer won: ROSTER > MEMBER > TEAM > COMPANY > COUNTRY_PACK. */
  source: WorkingHoursSource;
  /** The winning policy row's id (null for ROSTER / COUNTRY_PACK). */
  policyId: string | null;
  /** For TEAM: the department the policy is attached to (may be an ANCESTOR of the member's own department). */
  sourceDepartmentId: string | null;
  /** The named shift behind the winning layer (a roster cell's shift, or a standing shift), else null (custom hours / Country Pack). */
  shift: EffectiveShiftInfo | null;
  /** True when a PUBLISHED dated roster assignment applies to this day (a day off or a shift). */
  rostered: boolean;
  /** True when the roster explicitly gives the day off. */
  dayOff: boolean;
}

/** One layer of the standing (non-dated) resolution. */
export interface StandingInfo {
  source: Exclude<WorkingHoursSource, 'ROSTER'>;
  policyId: string | null;
  sourceDepartmentId: string | null;
  shift: EffectiveShiftInfo | null;
  /** Resolved hours when a policy row decided (shift or custom); null for the Country Pack fallback. */
  policy: EffectivePolicyValues | null;
}

type PolicyRow = WorkingHoursPolicy & { shiftDefinition: ShiftDefinition | null };

const MAX_DEPARTMENT_DEPTH = 12;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function toShiftInfo(shift: ShiftDefinition): EffectiveShiftInfo {
  return {
    id: shift.id,
    name: shift.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    crossesMidnight: shift.crossesMidnight,
    color: shift.color,
  };
}

/** THE mapping from a shift to working-hours values — delegates to the shared pure function. */
export function policyFromShift(shift: ShiftDefinition): EffectivePolicyValues {
  return shiftToWorkingHours(shift);
}

/** A custom policy row's values (a `shift`-linked row reads its hours LIVE from the shift). */
export function policyFromRow(row: PolicyRow): EffectivePolicyValues {
  if (row.shiftDefinition) return policyFromShift(row.shiftDefinition);
  const workHours = row.workHours as number;
  const breakHours = row.breakHours as number;
  const derived = row.halfDayThresholdHours == null;
  return {
    startTime: row.startTime as string,
    workHours,
    breakHours,
    requiredHours: requiredHoursOf(workHours, breakHours),
    graceMinutes: row.graceMinutes,
    halfDayThresholdHours: derived
      ? defaultHalfDayThreshold(workHours, breakHours)
      : (row.halfDayThresholdHours as number),
    halfDayThresholdDerived: derived,
  };
}

/**
 * Resolves the EFFECTIVE schedule for a member (step 8.1, made roster-aware in 8.2):
 *
 *   published dated roster (that day)  ??  member standing  ??  team standing (nearest dept)
 *     ??  company default  ??  Country Pack
 *
 * A "standing" layer is a `WorkingHoursPolicy` row — either custom hours or a link to a
 * named shift (whose hours are read LIVE, never copied). ONE precedence mechanism, so a
 * shift and a policy can never disagree about "this team works 9-5". Everything runs
 * through the caller's tenant-scoped `tx`, with an explicit `tenantId`, so it works the
 * same from an HTTP request and from a context-less BullMQ worker.
 */
@Injectable()
export class WorkingHoursResolverService {
  async resolve(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    date: string | null = null,
  ): Promise<EffectiveWorkingHours> {
    const range = await this.loadRange(
      tx,
      tenantId,
      employeeId,
      date ? new Date(`${date}T00:00:00.000Z`) : null,
      date ? new Date(`${date}T00:00:00.000Z`) : null,
    );
    return range.forDate(date ? new Date(`${date}T00:00:00.000Z`) : null);
  }

  /**
   * One standing resolution + ONE roster query for a whole range — never per day (a month of
   * classification stays a fixed handful of queries). `forDate` is a pure in-memory lookup.
   */
  async resolveRange(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    from: Date,
    to: Date,
  ) {
    return this.loadRange(tx, tenantId, employeeId, from, to);
  }

  /** The member's STANDING shift (null when the deciding layer is custom hours / the Country Pack). Roster not considered. */
  async standingShift(
    tx: Prisma.TransactionClient,
    employeeId: string,
  ): Promise<ShiftDefinition | null> {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true },
    });
    if (!employee) return null;
    const found = await this.findStandingRow(tx, employee);
    return found?.row.shiftDefinition ?? null;
  }

  /**
   * Batch standing resolution for a roster grid / coverage view: ONE policy query + ONE
   * department query for any number of employees (an in-memory walk), instead of the
   * per-employee queries `resolve` makes.
   */
  async resolveStandingBatch(
    tx: Prisma.TransactionClient,
    employees: { id: string; departmentId: string | null }[],
  ): Promise<Map<string, StandingInfo>> {
    const ids = employees.map((e) => e.id);
    const [policies, departments] = await Promise.all([
      tx.workingHoursPolicy.findMany({
        where: {
          OR: [
            { scope: 'COMPANY' },
            { scope: 'TEAM' },
            { scope: 'MEMBER', employeeId: { in: ids } },
          ],
        },
        include: { shiftDefinition: true },
      }),
      tx.department.findMany({ select: { id: true, parentDepartmentId: true }, take: 20000 }),
    ]);
    const memberRows = new Map<string, PolicyRow>();
    const teamRows = new Map<string, PolicyRow>();
    let company: PolicyRow | null = null;
    for (const p of policies) {
      if (p.scope === 'MEMBER' && p.employeeId) memberRows.set(p.employeeId, p);
      else if (p.scope === 'TEAM' && p.departmentId) teamRows.set(p.departmentId, p);
      else if (p.scope === 'COMPANY') company = p;
    }
    const parentOf = new Map(departments.map((d) => [d.id, d.parentDepartmentId]));

    const out = new Map<string, StandingInfo>();
    for (const e of employees) {
      const member = memberRows.get(e.id);
      if (member) {
        out.set(e.id, this.standingFromRow(member, 'MEMBER', null));
        continue;
      }
      let deptId = e.departmentId;
      const seen = new Set<string>();
      let team: { row: PolicyRow; deptId: string } | null = null;
      for (let depth = 0; deptId && depth < MAX_DEPARTMENT_DEPTH && !seen.has(deptId); depth += 1) {
        seen.add(deptId);
        const row = teamRows.get(deptId);
        if (row) {
          team = { row, deptId };
          break;
        }
        deptId = parentOf.get(deptId) ?? null;
      }
      if (team) out.set(e.id, this.standingFromRow(team.row, 'TEAM', team.deptId));
      else if (company) out.set(e.id, this.standingFromRow(company, 'COMPANY', null));
      else
        out.set(e.id, {
          source: 'COUNTRY_PACK',
          policyId: null,
          sourceDepartmentId: null,
          shift: null,
          policy: null,
        });
    }
    return out;
  }

  // --- internals -------------------------------------------------------

  private async loadRange(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    from: Date | null,
    to: Date | null,
  ) {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, branchId: true, departmentId: true },
    });
    if (!employee) {
      throw new NotFoundException(`Employee "${employeeId}" was not found.`);
    }
    const branch = await tx.branch.findUniqueOrThrow({
      where: { id: employee.branchId },
      select: { timezone: true },
    });
    const standing = await this.standingFor(tx, tenantId, employee);

    const rosterRows =
      from && to
        ? await tx.rosterAssignment.findMany({
            where: {
              employeeId: employee.id,
              status: 'PUBLISHED',
              effectiveFrom: { lte: to },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
            },
            include: { shiftDefinition: true },
          })
        : [];

    const base = {
      employeeId: employee.id,
      branchId: employee.branchId,
      timezone: branch.timezone,
    };
    const standingResult = (date: string | null): EffectiveWorkingHours => ({
      ...base,
      date,
      policy: standing.policy,
      source: standing.source,
      policyId: standing.policyId,
      sourceDepartmentId: standing.sourceDepartmentId,
      shift: standing.shift,
      rostered: false,
      dayOff: false,
    });

    return {
      timezone: branch.timezone,
      standing: standingResult(null),
      forDate: (date: Date | null): EffectiveWorkingHours => {
        const key = date ? ymd(date) : null;
        const cell = date ? pickRosterAssignment(rosterRows, date) : null;
        if (!cell) return standingResult(key);
        if (cell.dayOff || !cell.shiftDefinition) {
          return {
            ...standingResult(key),
            source: 'ROSTER',
            policyId: null,
            sourceDepartmentId: null,
            shift: null,
            rostered: true,
            dayOff: true,
          };
        }
        return {
          ...standingResult(key),
          policy: policyFromShift(cell.shiftDefinition),
          source: 'ROSTER',
          policyId: null,
          sourceDepartmentId: null,
          shift: toShiftInfo(cell.shiftDefinition),
          rostered: true,
          dayOff: false,
        };
      },
    };
  }

  /** Member -> nearest department -> company row, the first hit decides. */
  private async findStandingRow(
    tx: Prisma.TransactionClient,
    employee: { id: string; departmentId: string | null },
  ): Promise<{
    row: PolicyRow;
    source: 'MEMBER' | 'TEAM' | 'COMPANY';
    departmentId: string | null;
  } | null> {
    const member = await tx.workingHoursPolicy.findFirst({
      where: { scope: 'MEMBER', employeeId: employee.id },
      include: { shiftDefinition: true },
    });
    if (member) return { row: member, source: 'MEMBER', departmentId: null };

    let departmentId = employee.departmentId;
    const seen = new Set<string>();
    for (
      let depth = 0;
      departmentId && depth < MAX_DEPARTMENT_DEPTH && !seen.has(departmentId);
      depth += 1
    ) {
      seen.add(departmentId);
      const team = await tx.workingHoursPolicy.findFirst({
        where: { scope: 'TEAM', departmentId },
        include: { shiftDefinition: true },
      });
      if (team) return { row: team, source: 'TEAM', departmentId };
      const dept = await tx.department.findUnique({
        where: { id: departmentId },
        select: { parentDepartmentId: true },
      });
      departmentId = dept?.parentDepartmentId ?? null;
    }

    const company = await tx.workingHoursPolicy.findFirst({
      where: { scope: 'COMPANY' },
      include: { shiftDefinition: true },
    });
    return company ? { row: company, source: 'COMPANY', departmentId: null } : null;
  }

  private standingFromRow(
    row: PolicyRow,
    source: 'MEMBER' | 'TEAM' | 'COMPANY',
    departmentId: string | null,
  ): StandingInfo {
    return {
      source,
      policyId: row.id,
      sourceDepartmentId: departmentId,
      shift: row.shiftDefinition ? toShiftInfo(row.shiftDefinition) : null,
      policy: policyFromRow(row),
    };
  }

  private async standingFor(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employee: { id: string; branchId: string; departmentId: string | null },
  ): Promise<StandingInfo & { policy: EffectivePolicyValues }> {
    const found = await this.findStandingRow(tx, employee);
    if (found)
      return this.standingFromRow(found.row, found.source, found.departmentId) as StandingInfo & {
        policy: EffectivePolicyValues;
      };
    return {
      source: 'COUNTRY_PACK',
      policyId: null,
      sourceDepartmentId: null,
      shift: null,
      policy: await this.fromCountryPack(tx, tenantId, employee.branchId),
    };
  }

  /**
   * The final fallback: the Country Pack's `workingTime` has only `standardWeeklyHours` +
   * `weekendDays`, so the daily work hours are standardWeeklyHours / (7 - weekend days)
   * (US: 40/5 = 8); start time, break and grace use WORKING_HOURS_DEFAULTS (09:00 / 1h / 15m).
   */
  private async fromCountryPack(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
  ): Promise<EffectivePolicyValues> {
    const pack = await resolveAttendancePackConfig(tx, tenantId, branchId);
    const workingDays = Math.max(1, 7 - pack.weekendDays.length);
    const workHours = Math.round((pack.standardWeeklyHours / workingDays) * 100) / 100;
    const breakHours = WORKING_HOURS_DEFAULTS.breakHours;
    return {
      startTime: WORKING_HOURS_DEFAULTS.startTime,
      workHours,
      breakHours,
      requiredHours: requiredHoursOf(workHours, breakHours),
      graceMinutes: WORKING_HOURS_DEFAULTS.graceMinutes,
      halfDayThresholdHours: defaultHalfDayThreshold(workHours, breakHours),
      halfDayThresholdDerived: true,
    };
  }
}
