import { PublicHolidaysCalendar, WEEKDAYS, Weekday } from '@hrm/shared';

/**
 * Pure day-classification helpers — the SAME weekend/holiday derivation
 * `leave-day-calculator.ts` (1.2) already established (duplicated rather
 * than imported, the "reuse the pattern, not the file" posture this
 * codebase's country-pack resolvers already take with each other): pure
 * UTC-normalized arithmetic on a `@db.Date` calendar date, never the server
 * process's local timezone. THE RULE (country-packs.md) holds — both are
 * driven entirely by the resolved pack's data, never a country-code branch.
 */
export function isWeekend(workDate: Date, weekendDays: readonly Weekday[]): boolean {
  return weekendDays.includes(WEEKDAYS[workDate.getUTCDay()]);
}

export function isPublicHoliday(workDate: Date, publicHolidays: PublicHolidaysCalendar): boolean {
  const year = String(workDate.getUTCFullYear());
  const dateStr = workDate.toISOString().slice(0, 10);
  return (publicHolidays[year] ?? []).some((holiday) => holiday.date === dateStr);
}
