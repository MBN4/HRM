/**
 * Pro-rates a mid-period joiner's monthly accrual — see docs/conventions/leave.md.
 * `null` means "joined after this period entirely, no accrual for this
 * month at all" (a future-dated joiner accrued retroactively would be
 * wrong). A joiner from a PRIOR month/year gets the full month (`1`).
 * Leaver pro-rating (a termination DATE) is a documented, out-of-scope gap
 * for this step — `Employee` has no `terminatedAt` column yet, only a
 * `TERMINATED` status with no date attached.
 */
export function prorationFactorForJoinMonth(joinDate: Date, periodYear: number, periodMonth: number): number | null {
  const joinYear = joinDate.getUTCFullYear();
  const joinMonth = joinDate.getUTCMonth() + 1;

  if (joinYear > periodYear || (joinYear === periodYear && joinMonth > periodMonth)) {
    return null;
  }
  if (joinYear === periodYear && joinMonth === periodMonth) {
    const daysInMonth = new Date(Date.UTC(periodYear, periodMonth, 0)).getUTCDate();
    const remainingDays = daysInMonth - joinDate.getUTCDate() + 1;
    return remainingDays / daysInMonth;
  }
  return 1;
}
