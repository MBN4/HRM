import { computeCalibrationRows, nearestLevelValue } from './calibration-rollup.util';

const LEVELS = [1, 2, 3, 4, 5].map((value) => ({ value, label: `Level ${value}` }));

describe('nearestLevelValue', () => {
  it('rounds a continuous rating to the nearest defined level', () => {
    expect(nearestLevelValue(LEVELS, 4)).toBe(4);
    expect(nearestLevelValue(LEVELS, 3.9)).toBe(4);
    expect(nearestLevelValue(LEVELS, 3.4)).toBe(3);
  });

  it('works with a non-integer, non-contiguous scale', () => {
    const passFail = [
      { value: 0, label: 'Fail' },
      { value: 1, label: 'Pass' },
    ];
    expect(nearestLevelValue(passFail, 0.6)).toBe(1);
    expect(nearestLevelValue(passFail, 0.4)).toBe(0);
  });
});

describe('computeCalibrationRows', () => {
  it('groups by branch, department, and rounded rating value', () => {
    const rows = computeCalibrationRows(
      [
        { overallRating: 4, branchId: 'b1', departmentId: 'd1' },
        { overallRating: 4.1, branchId: 'b1', departmentId: 'd1' },
        { overallRating: 3, branchId: 'b1', departmentId: 'd2' },
        { overallRating: 5, branchId: 'b2', departmentId: null },
      ],
      LEVELS,
    );

    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({ branchId: 'b1', departmentId: 'd1', ratingValue: 4, employeeCount: 2 });
    expect(rows).toContainEqual({ branchId: 'b1', departmentId: 'd2', ratingValue: 3, employeeCount: 1 });
    expect(rows).toContainEqual({ branchId: 'b2', departmentId: null, ratingValue: 5, employeeCount: 1 });
  });

  it('returns an empty array for no input rows', () => {
    expect(computeCalibrationRows([], LEVELS)).toEqual([]);
  });

  it('never double-counts a NULL departmentId against a set one (the Postgres-unique-index-NULL gotcha this table is designed around)', () => {
    const rows = computeCalibrationRows(
      [
        { overallRating: 3, branchId: 'b1', departmentId: null },
        { overallRating: 3, branchId: 'b1', departmentId: 'd1' },
      ],
      LEVELS,
    );
    expect(rows).toHaveLength(2);
  });
});
