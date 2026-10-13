/**
 * The ONE rule for choosing between overlapping DATED roster rows for a day (step 8.2).
 * Legacy 1.3 rows are ranges ("Night shift from the 1st, ongoing"); the 8.2 calendar writes
 * single-day "cells". When both cover a date, the NARROWEST span wins (a one-day cell beats
 * an ongoing range), then the latest `effectiveFrom`, then the most recently created.
 * Pure + dependency-free so the resolver, the clock-in path and the grid share it.
 */
export interface PickableRosterRow {
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
}

const DAY_MS = 86_400_000;

export function rosterCovers(row: PickableRosterRow, date: Date): boolean {
  return (
    row.effectiveFrom.getTime() <= date.getTime() &&
    (row.effectiveTo === null || row.effectiveTo.getTime() >= date.getTime())
  );
}

export function pickRosterAssignment<T extends PickableRosterRow>(
  rows: readonly T[],
  date: Date,
): T | null {
  let best: T | null = null;
  let bestSpan = Infinity;
  for (const row of rows) {
    if (!rosterCovers(row, date)) continue;
    const span =
      row.effectiveTo === null
        ? Infinity
        : Math.round((row.effectiveTo.getTime() - row.effectiveFrom.getTime()) / DAY_MS) + 1;
    if (
      !best ||
      span < bestSpan ||
      (span === bestSpan &&
        (row.effectiveFrom.getTime() > best.effectiveFrom.getTime() ||
          (row.effectiveFrom.getTime() === best.effectiveFrom.getTime() &&
            row.createdAt.getTime() > best.createdAt.getTime())))
    ) {
      best = row;
      bestSpan = span;
    }
  }
  return best;
}
