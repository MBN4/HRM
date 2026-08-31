import {
  computeAttendanceBranchSummaryRows,
  computeHeadcountSnapshotRows,
  computeLeaveUtilizationRows,
  computeMovementRows,
  toUtcDateOnly,
  yesterdayUtc,
} from './analytics-rollup.util';

const BRANCH_US = 'branch-us';
const BRANCH_QA = 'branch-qa';
const DEPT_ENG = 'dept-eng';

describe('toUtcDateOnly / yesterdayUtc', () => {
  it('truncates any instant to UTC midnight', () => {
    expect(toUtcDateOnly(new Date('2026-03-02T23:59:59.999Z')).toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('resolves the previous UTC calendar day', () => {
    expect(yesterdayUtc(new Date('2026-03-02T00:30:00.000Z')).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('computeHeadcountSnapshotRows — grouped by (branch, department, employmentType, gender)', () => {
  it('groups matching employees into one row with a summed count', () => {
    const rows = computeHeadcountSnapshotRows([
      { branchId: BRANCH_US, departmentId: DEPT_ENG, employmentType: 'FULL_TIME', gender: 'FEMALE' },
      { branchId: BRANCH_US, departmentId: DEPT_ENG, employmentType: 'FULL_TIME', gender: 'FEMALE' },
      { branchId: BRANCH_US, departmentId: null, employmentType: 'CONTRACT', gender: null },
      { branchId: BRANCH_QA, departmentId: DEPT_ENG, employmentType: 'FULL_TIME', gender: 'MALE' },
    ]);

    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({ branchId: BRANCH_US, departmentId: DEPT_ENG, employmentType: 'FULL_TIME', gender: 'FEMALE', activeCount: 2 });
    expect(rows).toContainEqual({ branchId: BRANCH_US, departmentId: null, employmentType: 'CONTRACT', gender: null, activeCount: 1 });
    expect(rows).toContainEqual({ branchId: BRANCH_QA, departmentId: DEPT_ENG, employmentType: 'FULL_TIME', gender: 'MALE', activeCount: 1 });
  });

  it('returns no rows for an empty input', () => {
    expect(computeHeadcountSnapshotRows([])).toEqual([]);
  });
});

describe('computeMovementRows — one calendar day at a time', () => {
  const movementDate = new Date('2026-03-02T00:00:00.000Z');

  it('counts a joiner whose joinDate matches the target day, grouped by current branch/department', () => {
    const rows = computeMovementRows(
      [
        { branchId: BRANCH_US, departmentId: DEPT_ENG, joinDate: new Date('2026-03-02T00:00:00.000Z'), terminatedAt: null },
        { branchId: BRANCH_US, departmentId: DEPT_ENG, joinDate: new Date('2026-01-01T00:00:00.000Z'), terminatedAt: null },
      ],
      movementDate,
    );
    expect(rows).toEqual([{ branchId: BRANCH_US, departmentId: DEPT_ENG, movementType: 'JOINER', count: 1 }]);
  });

  it('counts a leaver whose terminatedAt matches the target day, independent of joinDate', () => {
    const rows = computeMovementRows(
      [{ branchId: BRANCH_QA, departmentId: null, joinDate: new Date('2020-01-01T00:00:00.000Z'), terminatedAt: new Date('2026-03-02T15:00:00.000Z') }],
      movementDate,
    );
    expect(rows).toEqual([{ branchId: BRANCH_QA, departmentId: null, movementType: 'LEAVER', count: 1 }]);
  });

  it('counts the SAME employee as both a joiner and a leaver if both dates match (same-day hire and termination)', () => {
    const rows = computeMovementRows(
      [{ branchId: BRANCH_US, departmentId: null, joinDate: movementDate, terminatedAt: movementDate }],
      movementDate,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { branchId: BRANCH_US, departmentId: null, movementType: 'JOINER', count: 1 },
        { branchId: BRANCH_US, departmentId: null, movementType: 'LEAVER', count: 1 },
      ]),
    );
  });
});

describe('computeAttendanceBranchSummaryRows — rolls up AttendanceDailySummary rows, never touches raw records', () => {
  it('tallies status counts and sums minutes per (branch, department)', () => {
    const rows = computeAttendanceBranchSummaryRows([
      { branchId: BRANCH_US, departmentId: DEPT_ENG, status: 'PRESENT', workedMinutes: 480, overtimeMinutes: 0, lateMinutes: 0 },
      { branchId: BRANCH_US, departmentId: DEPT_ENG, status: 'LATE', workedMinutes: 450, overtimeMinutes: 0, lateMinutes: 30 },
      { branchId: BRANCH_US, departmentId: DEPT_ENG, status: 'ABSENT', workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0 },
      { branchId: BRANCH_QA, departmentId: null, status: 'WEEKEND', workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0 },
    ]);

    const usEng = rows.find((r) => r.branchId === BRANCH_US && r.departmentId === DEPT_ENG)!;
    expect(usEng.presentCount).toBe(1);
    expect(usEng.lateCount).toBe(1);
    expect(usEng.absentCount).toBe(1);
    expect(usEng.totalWorkedMinutes).toBe(930);
    expect(usEng.totalLateMinutes).toBe(30);
    expect(usEng.employeeCount).toBe(3);

    const qa = rows.find((r) => r.branchId === BRANCH_QA)!;
    expect(qa.weekendCount).toBe(1);
    expect(qa.employeeCount).toBe(1);
  });
});

describe('computeLeaveUtilizationRows — rolls up current-year LeaveBalance rows', () => {
  it('sums entitled/accrued/used days per (branch, department, leaveType)', () => {
    const rows = computeLeaveUtilizationRows([
      { branchId: BRANCH_US, departmentId: DEPT_ENG, leaveType: 'ANNUAL', entitledDays: 10, accruedDays: 5, usedDays: 2 },
      { branchId: BRANCH_US, departmentId: DEPT_ENG, leaveType: 'ANNUAL', entitledDays: 10, accruedDays: 5, usedDays: 4 },
      { branchId: BRANCH_US, departmentId: DEPT_ENG, leaveType: 'SICK', entitledDays: 5, accruedDays: 5, usedDays: 1 },
    ]);

    const annual = rows.find((r) => r.leaveType === 'ANNUAL')!;
    expect(annual.totalEntitledDays).toBe(20);
    expect(annual.totalAccruedDays).toBe(10);
    expect(annual.totalUsedDays).toBe(6);
    expect(annual.employeeCount).toBe(2);

    const sick = rows.find((r) => r.leaveType === 'SICK')!;
    expect(sick.totalUsedDays).toBe(1);
    expect(sick.employeeCount).toBe(1);
  });
});
