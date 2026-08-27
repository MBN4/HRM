import { BadRequestException } from '@nestjs/common';
import { PublicHolidaysCalendar, WEEKDAYS, Weekday } from '@hrm/shared';

/**
 * Counts the business days in `[startDate, endDate]` (inclusive) — weekends
 * (per the resolved Country Pack's `workingTime.weekendDays`, e.g. Sat/Sun
 * for a US branch vs. Fri/Sat for a QA branch) and that branch's resolved
 * `publicHolidays` for the relevant year(s) excluded. See
 * docs/conventions/leave.md and docs/conventions/i18n-timezone-rtl.md's UTC
 * storage convention: `startDate`/`endDate` are pure calendar dates (Prisma
 * `@db.Date` columns / `z.coerce.date()`-parsed "YYYY-MM-DD" strings, which
 * parse as UTC midnight per the ISO-8601 spec), so this walks dates using
 * UTC-normalized arithmetic throughout — deliberately never touching the
 * server process's local timezone, which would silently shift a date's
 * weekday depending on where the API happens to be deployed.
 */
export function countBusinessDays(
  startDate: Date,
  endDate: Date,
  weekendDays: readonly Weekday[],
  publicHolidays: PublicHolidaysCalendar,
): number {
  const cursor = toUtcMidnight(startDate);
  const end = toUtcMidnight(endDate);
  if (end < cursor) {
    throw new BadRequestException('endDate must be on or after startDate.');
  }

  const weekendSet = new Set(weekendDays);
  let count = 0;

  while (cursor <= end) {
    const weekday = WEEKDAYS[cursor.getUTCDay()];
    if (!weekendSet.has(weekday) && !isPublicHoliday(cursor, publicHolidays)) {
      count++;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return count;
}

function isPublicHoliday(date: Date, publicHolidays: PublicHolidaysCalendar): boolean {
  const year = String(date.getUTCFullYear());
  const dateStr = date.toISOString().slice(0, 10);
  return (publicHolidays[year] ?? []).some((holiday) => holiday.date === dateStr);
}

function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
