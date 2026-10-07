import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, WorkingHoursPolicy } from '@hrm/db';
import {
  defaultHalfDayThreshold,
  requiredHoursOf,
  WORKING_HOURS_DEFAULTS,
  type WorkingHoursSource,
} from '@hrm/shared';
import { resolveAttendancePackConfig } from '../attendance/attendance-country-pack.util';

/** The resolved schedule — what later parts (day-status classification, the attendance graph) consume. */
export interface EffectiveWorkingHours {
  employeeId: string;
  branchId: string;
  /** The member's BRANCH timezone (IANA) — never stored on a policy. */
  timezone: string;
  /** Echo of the requested date (YYYY-MM-DD); policies are not date-versioned yet. */
  date: string | null;
  policy: {
    startTime: string;
    workHours: number;
    breakHours: number;
    requiredHours: number;
    graceMinutes: number;
    halfDayThresholdHours: number;
    /** True when the threshold was derived (requiredHours / 2) rather than set on the policy. */
    halfDayThresholdDerived: boolean;
  };
  /** Which layer won: MEMBER > TEAM > COMPANY > COUNTRY_PACK. */
  source: WorkingHoursSource;
  /** The winning policy row's id (null for COUNTRY_PACK). */
  policyId: string | null;
  /** For TEAM: the department the policy is attached to (may be an ANCESTOR of the member's own department). */
  sourceDepartmentId: string | null;
}

const MAX_DEPARTMENT_DEPTH = 12;

/**
 * Resolves the EFFECTIVE working-hours policy for a member (step 8.1):
 *
 *   member override ?? team/department policy ?? company default ?? Country Pack
 *
 * Team = the member's department; a department with no policy of its own
 * inherits the NEAREST ancestor department's. Everything runs through the
 * caller's tenant-scoped `tx` (RLS), with an explicit `tenantId`, so it works
 * the same from an HTTP request and from a context-less BullMQ worker (the
 * exact constraint attendance-country-pack.util.ts documents).
 */
@Injectable()
export class WorkingHoursResolverService {
  async resolve(tx: Prisma.TransactionClient, tenantId: string, employeeId: string, date: string | null = null): Promise<EffectiveWorkingHours> {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, branchId: true, departmentId: true },
    });
    if (!employee) {
      throw new NotFoundException(`Employee "${employeeId}" was not found.`);
    }
    const branch = await tx.branch.findUniqueOrThrow({ where: { id: employee.branchId }, select: { timezone: true } });

    const base = { employeeId: employee.id, branchId: employee.branchId, timezone: branch.timezone, date };

    const memberPolicy = await tx.workingHoursPolicy.findFirst({ where: { scope: 'MEMBER', employeeId: employee.id } });
    if (memberPolicy) {
      return { ...base, ...this.fromRow(memberPolicy), source: 'MEMBER', policyId: memberPolicy.id, sourceDepartmentId: null };
    }

    // Walk the department chain (own -> parent -> ...) for the nearest TEAM policy.
    let departmentId = employee.departmentId;
    const seen = new Set<string>();
    for (let depth = 0; departmentId && depth < MAX_DEPARTMENT_DEPTH && !seen.has(departmentId); depth += 1) {
      seen.add(departmentId);
      const teamPolicy = await tx.workingHoursPolicy.findFirst({ where: { scope: 'TEAM', departmentId } });
      if (teamPolicy) {
        return { ...base, ...this.fromRow(teamPolicy), source: 'TEAM', policyId: teamPolicy.id, sourceDepartmentId: departmentId };
      }
      const dept = await tx.department.findUnique({ where: { id: departmentId }, select: { parentDepartmentId: true } });
      departmentId = dept?.parentDepartmentId ?? null;
    }

    const company = await tx.workingHoursPolicy.findFirst({ where: { scope: 'COMPANY' } });
    if (company) {
      return { ...base, ...this.fromRow(company), source: 'COMPANY', policyId: company.id, sourceDepartmentId: null };
    }

    return { ...base, ...(await this.fromCountryPack(tx, tenantId, employee.branchId)), source: 'COUNTRY_PACK', policyId: null, sourceDepartmentId: null };
  }

  private fromRow(row: WorkingHoursPolicy): Pick<EffectiveWorkingHours, 'policy'> {
    const derived = row.halfDayThresholdHours == null;
    return {
      policy: {
        startTime: row.startTime,
        workHours: row.workHours,
        breakHours: row.breakHours,
        requiredHours: requiredHoursOf(row.workHours, row.breakHours),
        graceMinutes: row.graceMinutes,
        halfDayThresholdHours: derived ? defaultHalfDayThreshold(row.workHours, row.breakHours) : (row.halfDayThresholdHours as number),
        halfDayThresholdDerived: derived,
      },
    };
  }

  /**
   * The final fallback: the Country Pack's `workingTime` has only
   * `standardWeeklyHours` + `weekendDays`, so the daily work hours are
   * standardWeeklyHours / (7 - weekend days) (US: 40/5 = 8); start time, break
   * and grace use WORKING_HOURS_DEFAULTS (09:00 / 1h / 15m); half-day is derived.
   */
  private async fromCountryPack(tx: Prisma.TransactionClient, tenantId: string, branchId: string): Promise<Pick<EffectiveWorkingHours, 'policy'>> {
    const pack = await resolveAttendancePackConfig(tx, tenantId, branchId);
    const workingDays = Math.max(1, 7 - pack.weekendDays.length);
    const workHours = Math.round((pack.standardWeeklyHours / workingDays) * 100) / 100;
    const breakHours = WORKING_HOURS_DEFAULTS.breakHours;
    return {
      policy: {
        startTime: WORKING_HOURS_DEFAULTS.startTime,
        workHours,
        breakHours,
        requiredHours: requiredHoursOf(workHours, breakHours),
        graceMinutes: WORKING_HOURS_DEFAULTS.graceMinutes,
        halfDayThresholdHours: defaultHalfDayThreshold(workHours, breakHours),
        halfDayThresholdDerived: true,
      },
    };
  }
}
