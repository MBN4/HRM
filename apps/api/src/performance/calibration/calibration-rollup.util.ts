import type { RatingLevel } from '@hrm/shared';

export interface CalibrationInputRow {
  overallRating: number;
  branchId: string;
  departmentId: string | null;
}

export interface CalibrationOutputRow {
  branchId: string;
  departmentId: string | null;
  ratingValue: number;
  employeeCount: number;
}

/** Nearest-neighbor rounding of a continuous average rating to a DEFINED level value in the scale — a documented simplification (see docs/conventions/performance.md), not interpolation. */
export function nearestLevelValue(levels: RatingLevel[], rating: number): number {
  return levels.reduce((closest, level) => (Math.abs(level.value - rating) < Math.abs(closest - rating) ? level.value : closest), levels[0].value);
}

/**
 * Pure grouping function — the same "no DB, unit-testable" shape
 * `analytics-rollup.util.ts`'s `compute*Rows` functions already establish.
 * Groups completed appraisals by `(branchId, departmentId, ratingValue)`
 * and counts employees per bucket — the ONLY aggregation this module ever
 * performs, done once by a background job, never live on a dashboard read
 * (see `CalibrationProcessor`/`CalibrationService`).
 */
export function computeCalibrationRows(rows: CalibrationInputRow[], levels: RatingLevel[]): CalibrationOutputRow[] {
  const grouped = new Map<string, CalibrationOutputRow>();
  for (const row of rows) {
    const ratingValue = nearestLevelValue(levels, row.overallRating);
    const key = `${row.branchId}|${row.departmentId ?? ''}|${ratingValue}`;
    const entry = grouped.get(key) ?? { branchId: row.branchId, departmentId: row.departmentId, ratingValue, employeeCount: 0 };
    entry.employeeCount += 1;
    grouped.set(key, entry);
  }
  return [...grouped.values()];
}
