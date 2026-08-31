import type { AttendanceDayStatus, EmploymentType, Gender, LeaveType } from '@hrm/db';

/**
 * Pure aggregation logic for the four analytics rollup tables — see
 * docs/conventions/analytics-dashboard.md. Deliberately separated from the
 * DB-fetching processor/service (`AnalyticsRollupProcessor`) the same way
 * `attendance-metrics.util.ts` separates pure metric computation from
 * `AttendanceClockService`'s DB calls: these functions take plain arrays
 * already fetched from the DB and return the exact rows to bulk-insert, so
 * they're testable with no Postgres/tenant-context dependency at all.
 *
 * `toUtcDateOnly` truncates any `Date`/instant to UTC midnight — every
 * rollup table's date column is `@db.Date`, and grouping "the same day"
 * correctly requires comparing calendar dates, not instants.
 */
export function toUtcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function yesterdayUtc(now: Date = new Date()): Date {
  const today = toUtcDateOnly(now);
  today.setUTCDate(today.getUTCDate() - 1);
  return today;
}

export interface EmployeeHeadcountInput {
  branchId: string;
  departmentId: string | null;
  employmentType: EmploymentType;
  gender: Gender | null;
}

export interface HeadcountSnapshotRow {
  branchId: string;
  departmentId: string | null;
  employmentType: EmploymentType;
  gender: Gender | null;
  activeCount: number;
}

/**
 * "Active" for headcount purposes means currently employed (ACTIVE or
 * ON_LEAVE) — callers pass in only employees already filtered that way
 * (see AnalyticsRollupProcessor), so this function has no status field to
 * branch on at all.
 */
export function computeHeadcountSnapshotRows(employees: EmployeeHeadcountInput[]): HeadcountSnapshotRow[] {
  const grouped = new Map<string, HeadcountSnapshotRow>();
  for (const employee of employees) {
    const key = [employee.branchId, employee.departmentId ?? '', employee.employmentType, employee.gender ?? ''].join('|');
    const existing = grouped.get(key);
    if (existing) {
      existing.activeCount += 1;
    } else {
      grouped.set(key, {
        branchId: employee.branchId,
        departmentId: employee.departmentId,
        employmentType: employee.employmentType,
        gender: employee.gender,
        activeCount: 1,
      });
    }
  }
  return [...grouped.values()];
}

export interface EmployeeMovementInput {
  branchId: string;
  departmentId: string | null;
  joinDate: Date;
  terminatedAt: Date | null;
}

export type MovementType = 'JOINER' | 'LEAVER';

export interface MovementCountRow {
  branchId: string;
  departmentId: string | null;
  movementType: MovementType;
  count: number;
}

/** One calendar day at a time — a joiner/leaver whose join/termination date matches `movementDate`, grouped by their CURRENT branch/department (see the schema doc comment for why). */
export function computeMovementRows(employees: EmployeeMovementInput[], movementDate: Date): MovementCountRow[] {
  const target = toUtcDateOnly(movementDate).getTime();
  const grouped = new Map<string, MovementCountRow>();

  const bump = (branchId: string, departmentId: string | null, movementType: MovementType) => {
    const key = [branchId, departmentId ?? '', movementType].join('|');
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { branchId, departmentId, movementType, count: 1 });
    }
  };

  for (const employee of employees) {
    if (toUtcDateOnly(employee.joinDate).getTime() === target) {
      bump(employee.branchId, employee.departmentId, 'JOINER');
    }
    if (employee.terminatedAt && toUtcDateOnly(employee.terminatedAt).getTime() === target) {
      bump(employee.branchId, employee.departmentId, 'LEAVER');
    }
  }

  return [...grouped.values()];
}

export interface AttendanceSummaryInput {
  branchId: string;
  departmentId: string | null;
  status: AttendanceDayStatus;
  workedMinutes: number;
  overtimeMinutes: number;
  lateMinutes: number;
}

export interface AttendanceBranchSummaryRow {
  branchId: string;
  departmentId: string | null;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  onLeaveCount: number;
  weekendCount: number;
  holidayCount: number;
  totalWorkedMinutes: number;
  totalOvertimeMinutes: number;
  totalLateMinutes: number;
  employeeCount: number;
}

const STATUS_COUNT_FIELD: Record<AttendanceDayStatus, keyof AttendanceBranchSummaryRow | null> = {
  PRESENT: 'presentCount',
  LATE: 'lateCount',
  ABSENT: 'absentCount',
  ON_LEAVE: 'onLeaveCount',
  WEEKEND: 'weekendCount',
  HOLIDAY: 'holidayCount',
};

function emptyAttendanceRow(branchId: string, departmentId: string | null): AttendanceBranchSummaryRow {
  return {
    branchId,
    departmentId,
    presentCount: 0,
    absentCount: 0,
    lateCount: 0,
    onLeaveCount: 0,
    weekendCount: 0,
    holidayCount: 0,
    totalWorkedMinutes: 0,
    totalOvertimeMinutes: 0,
    totalLateMinutes: 0,
    employeeCount: 0,
  };
}

/** Rolls up 1.3's `AttendanceDailySummary` rows (already ≤1/employee/day) by (branchId, departmentId) — never touches raw `AttendanceRecord`. */
export function computeAttendanceBranchSummaryRows(summaries: AttendanceSummaryInput[]): AttendanceBranchSummaryRow[] {
  const grouped = new Map<string, AttendanceBranchSummaryRow>();

  for (const summary of summaries) {
    const key = [summary.branchId, summary.departmentId ?? ''].join('|');
    const row = grouped.get(key) ?? emptyAttendanceRow(summary.branchId, summary.departmentId);
    const field = STATUS_COUNT_FIELD[summary.status];
    if (field) {
      (row[field] as number) += 1;
    }
    row.totalWorkedMinutes += summary.workedMinutes;
    row.totalOvertimeMinutes += summary.overtimeMinutes;
    row.totalLateMinutes += summary.lateMinutes;
    row.employeeCount += 1;
    grouped.set(key, row);
  }

  return [...grouped.values()];
}

export interface LeaveBalanceInput {
  branchId: string;
  departmentId: string | null;
  leaveType: LeaveType;
  entitledDays: number;
  accruedDays: number;
  usedDays: number;
}

export interface LeaveUtilizationRow {
  branchId: string;
  departmentId: string | null;
  leaveType: LeaveType;
  totalEntitledDays: number;
  totalAccruedDays: number;
  totalUsedDays: number;
  employeeCount: number;
}

/** Rolls up the current-year `LeaveBalance` rows (already ≤1/employee/type/year) by (branchId, departmentId, leaveType). */
export function computeLeaveUtilizationRows(balances: LeaveBalanceInput[]): LeaveUtilizationRow[] {
  const grouped = new Map<string, LeaveUtilizationRow>();

  for (const balance of balances) {
    const key = [balance.branchId, balance.departmentId ?? '', balance.leaveType].join('|');
    const existing = grouped.get(key);
    if (existing) {
      existing.totalEntitledDays += balance.entitledDays;
      existing.totalAccruedDays += balance.accruedDays;
      existing.totalUsedDays += balance.usedDays;
      existing.employeeCount += 1;
    } else {
      grouped.set(key, {
        branchId: balance.branchId,
        departmentId: balance.departmentId,
        leaveType: balance.leaveType,
        totalEntitledDays: balance.entitledDays,
        totalAccruedDays: balance.accruedDays,
        totalUsedDays: balance.usedDays,
        employeeCount: 1,
      });
    }
  }

  return [...grouped.values()];
}
