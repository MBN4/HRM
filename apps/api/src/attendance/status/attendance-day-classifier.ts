import type { PublicHolidaysCalendar, Weekday, WorkingHoursSource } from '@hrm/shared';
import { isPublicHoliday, isWeekend } from '../summary/attendance-day-status.util';
import { addUtcDays, branchLocalToUtc } from '../attendance-timezone.util';

/**
 * Pure attendance day-status classification (step 8.1, Part 2) — see
 * docs/conventions/attendance-status.md. No DB, no clock: everything it needs
 * (the resolved Part-1 policy, the day's records, weekend/holiday/leave facts,
 * "now") is passed in, so every rule is unit-testable with exact instants.
 */

export const DAY_STATUSES = ['GREEN', 'YELLOW', 'RED', 'NEUTRAL', 'IN_PROGRESS'] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export const DAY_REASONS = [
  // GREEN / YELLOW
  'ON_TIME',
  'WITHIN_GRACE',
  // RED
  'LATE_BEYOND_GRACE',
  'HALF_DAY',
  'EARLY_OUT',
  'SHORT_DAY',
  'MISSING_CLOCK_OUT',
  'ABSENT',
  // NEUTRAL
  'WEEKEND',
  'HOLIDAY',
  'ON_LEAVE',
  'NOT_EMPLOYED',
  'FUTURE',
  'NOT_CLOCKED_IN',
  // IN_PROGRESS
  'CLOCKED_IN',
] as const;
export type DayReason = (typeof DAY_REASONS)[number];

export interface ClassifierPolicy {
  startTime: string;
  requiredHours: number;
  graceMinutes: number;
  halfDayThresholdHours: number;
}

export interface DayRecord {
  clockInAt: Date;
  clockOutAt: Date | null;
}

export interface ClassifyDayInput {
  /** Branch-local calendar day, UTC-midnight-normalized (`@db.Date` convention). */
  date: Date;
  /** The branch-local calendar day of `now` (same convention) — decides future / today. */
  today: Date;
  now: Date;
  timeZone: string;
  policy: ClassifierPolicy;
  policySource: WorkingHoursSource;
  weekendDays: readonly Weekday[];
  publicHolidays: PublicHolidaysCalendar;
  onApprovedLeave: boolean;
  /** False before the join date / after the termination date. */
  employed: boolean;
  /** Records attributed to this `workDate` (one row per shift). */
  records: DayRecord[];
}

export interface ClassifiedDay {
  date: string;
  status: DayStatus;
  /** The primary machine-readable reason; `reasons` lists every rule that fired. */
  reason: DayReason;
  reasons: DayReason[];
  isLate: boolean;
  minutesLate: number;
  isEarlyOut: boolean;
  minutesEarly: number;
  isShortDay: boolean;
  isHalfDay: boolean;
  hoursWorked: number;
  requiredHours: number;
  clockIn: string | null;
  clockOut: string | null;
  policySource: WorkingHoursSource;
}

/** An open record older than this is a forgotten clock-out, not a shift still in progress. */
export const MAX_OPEN_SHIFT_HOURS = 18;

const round2 = (n: number) => Math.round(n * 100) / 100;
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

export function classifyDay(input: ClassifyDayInput): ClassifiedDay {
  const { policy } = input;
  const closed = input.records.filter((r) => r.clockOutAt);
  const open = input.records.filter((r) => !r.clockOutAt);
  const earliestIn = input.records.length ? new Date(Math.min(...input.records.map((r) => r.clockInAt.getTime()))) : null;
  const latestOut = closed.length ? new Date(Math.max(...closed.map((r) => r.clockOutAt!.getTime()))) : null;

  let workedMs = closed.reduce((sum, r) => sum + (r.clockOutAt!.getTime() - r.clockInAt.getTime()), 0);
  const stillOpen = open.find(
    (r) => r.clockInAt <= input.now && input.now.getTime() - r.clockInAt.getTime() < MAX_OPEN_SHIFT_HOURS * 3_600_000,
  );
  if (stillOpen) workedMs += input.now.getTime() - stillOpen.clockInAt.getTime();
  const hoursWorked = round2(Math.max(0, workedMs) / 3_600_000);

  const base = {
    date: dateStr(input.date),
    isLate: false,
    minutesLate: 0,
    isEarlyOut: false,
    minutesEarly: 0,
    isShortDay: false,
    isHalfDay: false,
    hoursWorked,
    requiredHours: policy.requiredHours,
    clockIn: earliestIn ? earliestIn.toISOString() : null,
    clockOut: latestOut ? latestOut.toISOString() : null,
    policySource: input.policySource,
  };
  const make = (status: DayStatus, reasons: DayReason[], extra: Partial<ClassifiedDay> = {}): ClassifiedDay => ({
    ...base,
    ...extra,
    status,
    reason: reasons[0],
    reasons,
  });

  // 1. Live: clocked in right now, no clock-out yet.
  if (stillOpen) return make('IN_PROGRESS', ['CLOCKED_IN']);

  // 2. Not counted good or bad.
  if (!input.employed) return make('NEUTRAL', ['NOT_EMPLOYED']);
  if (isWeekend(input.date, input.weekendDays)) return make('NEUTRAL', ['WEEKEND']);
  if (isPublicHoliday(input.date, input.publicHolidays)) return make('NEUTRAL', ['HOLIDAY']);
  if (input.onApprovedLeave) return make('NEUTRAL', ['ON_LEAVE']);
  if (input.date.getTime() > input.today.getTime()) return make('NEUTRAL', ['FUTURE']);

  // 3. A working day with nothing recorded.
  if (input.records.length === 0) {
    return input.date.getTime() === input.today.getTime() ? make('NEUTRAL', ['NOT_CLOCKED_IN']) : make('RED', ['ABSENT']);
  }
  // 3b. Only an abandoned open record (forgot to clock out): the day cannot be verified.
  if (closed.length === 0) return make('RED', ['MISSING_CLOCK_OUT'], { isShortDay: true });

  // 4. Classify against the policy, in the BRANCH's local time. The expected start
  //    is a real instant (branchLocalToUtc), so lateness is true elapsed time, also
  //    across midnight-crossing shifts.
  const expectedStart = branchLocalToUtc(input.date, policy.startTime, input.timeZone);
  const minutesLate = Math.max(0, Math.floor((earliestIn!.getTime() - expectedStart.getTime()) / 60_000));
  const isLate = minutesLate > 0;
  const lateBeyondGrace = minutesLate > policy.graceMinutes;

  const expectedEnd = new Date(expectedStart.getTime() + policy.requiredHours * 3_600_000);
  const isShortDay = hoursWorked < policy.requiredHours;
  const isHalfDay = hoursWorked < policy.halfDayThresholdHours;
  const isEarlyOut = isShortDay && latestOut! < expectedEnd;
  const minutesEarly = isEarlyOut ? Math.ceil((expectedEnd.getTime() - latestOut!.getTime()) / 60_000) : 0;

  const reasons: DayReason[] = [];
  if (lateBeyondGrace) reasons.push('LATE_BEYOND_GRACE');
  if (isHalfDay) reasons.push('HALF_DAY');
  if (isEarlyOut) reasons.push('EARLY_OUT');
  if (isShortDay && !isHalfDay && !isEarlyOut) reasons.push('SHORT_DAY');

  const flags = { isLate, minutesLate, isEarlyOut, minutesEarly, isShortDay, isHalfDay };
  if (reasons.length > 0) return make('RED', reasons, flags);
  if (isLate) return make('YELLOW', ['WITHIN_GRACE'], flags);
  return make('GREEN', ['ON_TIME'], flags);
}

/** Every calendar day from..to inclusive (UTC-midnight dates). */
export function eachDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  for (let d = from; d.getTime() <= to.getTime(); d = addUtcDays(d, 1)) days.push(d);
  return days;
}
