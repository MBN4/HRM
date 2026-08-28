import { assertValidTimeZone } from '@hrm/shared';

export interface BranchLocalInstant {
  /** UTC-midnight-normalized calendar Date for the branch-local calendar day — same `@db.Date` convention as `LeaveRequest.startDate` (see docs/conventions/leave.md → Business-day counting). */
  calendarDate: Date;
  /** Minutes since branch-local midnight (0-1439). */
  minutesOfDay: number;
}

/**
 * Converts a UTC instant into the BRANCH's local calendar date + time-of-day
 * — the one place this module needs actual timezone MATH, not just display
 * rendering (`@hrm/shared`'s `formatInTimeZone` already covers that, but it
 * renders a human-readable string via `Intl.DateTimeFormat`'s `dateStyle`/
 * `timeStyle`, which is not machine-parseable back into numbers without
 * being locale-fragile). Built on the SAME native `Intl` API, extracting
 * numeric parts via `formatToParts` instead. This is what lets clock-in
 * attribute a shift to the correct BRANCH-LOCAL working day regardless of
 * the server process's own timezone or which branch/timezone the request
 * happens to be for — see docs/conventions/attendance.md.
 */
export function toBranchLocal(instant: Date, timeZone: string): BranchLocalInstant {
  assertValidTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  let hour = get('hour');
  const minute = get('minute');
  // Some ICU implementations render local midnight as "24" even under h23.
  if (hour === 24) {
    hour = 0;
  }

  return {
    calendarDate: new Date(Date.UTC(year, month - 1, day)),
    minutesOfDay: hour * 60 + minute,
  };
}

/** "HH:mm" -> minutes since midnight. */
export function minutesFromHHmm(hhmm: string): number {
  const [hour, minute] = hhmm.split(':').map(Number);
  return hour * 60 + minute;
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

export interface ShiftWindow {
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
}

/**
 * Resolves the BRANCH-LOCAL working day a clock-in is attributed to —
 * computed ONCE at clock-in and frozen on the record (see
 * `AttendanceRecord.workDate`'s own doc comment in schema.prisma); clock-out
 * never recomputes this, it just closes the same record. When the
 * employee's resolved shift crosses midnight and the clock-in's local
 * time-of-day falls before the shift's end time, this is the "past
 * midnight, still working the shift that started yesterday" case — the
 * clock-in is attributed to the PREVIOUS calendar day. Without a resolved
 * shift, there is no midnight-crossing signal to act on, so the clock-in's
 * own local calendar date is used as-is (a documented simplification — an
 * un-rostered employee clocking in just after midnight is attributed to
 * that new calendar day, not the day before).
 */
export function resolveWorkDate(clockInAt: Date, timeZone: string, shift: ShiftWindow | null): Date {
  const local = toBranchLocal(clockInAt, timeZone);
  if (shift?.crossesMidnight) {
    const endMinutes = minutesFromHHmm(shift.endTime);
    if (local.minutesOfDay < endMinutes) {
      return addUtcDays(local.calendarDate, -1);
    }
  }
  return local.calendarDate;
}

/**
 * The reverse of `toBranchLocal`: resolves the UTC instant corresponding to
 * a branch-local wall-clock date + "HH:mm" time — needed to turn a shift's
 * SCHEDULED start (branch-local, e.g. "09:00 on 2026-03-02") into a real
 * instant comparable against an actual `clockInAt` UTC timestamp, so
 * lateness is computed as true ELAPSED TIME rather than fragile
 * minutes-of-day modular arithmetic (which breaks across a midnight-
 * crossing shift). Uses the standard iterative-offset-correction technique
 * for converting a local wall-clock time to UTC without a heavy timezone
 * library: guess a UTC instant, see what it renders as locally, and adjust
 * by the difference — two iterations is enough for every real IANA zone
 * (including fractional-hour offsets); a DST transition on the exact
 * `workDate` could theoretically leave this off by up to an hour, a
 * documented, accepted simplification (see docs/conventions/attendance.md)
 * since it only affects the reported `lateMinutes` figure, never
 * `workDate` attribution itself (which only ever uses the forward
 * direction, `toBranchLocal`).
 */
export function branchLocalToUtc(calendarDate: Date, hhmm: string, timeZone: string): Date {
  assertValidTimeZone(timeZone);
  const [hour, minute] = hhmm.split(':').map(Number);
  const targetDayMinutes = Date.UTC(calendarDate.getUTCFullYear(), calendarDate.getUTCMonth(), calendarDate.getUTCDate()) / 60_000;
  const targetTotalMinutes = targetDayMinutes + hour * 60 + minute;

  let guess = Date.UTC(calendarDate.getUTCFullYear(), calendarDate.getUTCMonth(), calendarDate.getUTCDate(), hour, minute);
  for (let i = 0; i < 2; i++) {
    const local = toBranchLocal(new Date(guess), timeZone);
    const guessDayMinutes = local.calendarDate.getTime() / 60_000;
    const guessTotalMinutes = guessDayMinutes + local.minutesOfDay;
    const diffMinutes = targetTotalMinutes - guessTotalMinutes;
    if (diffMinutes === 0) {
      break;
    }
    guess += diffMinutes * 60_000;
  }
  return new Date(guess);
}
