import { WEEKDAYS } from '@hrm/shared';
import type { ScheduleDayKind } from './api/scheduling';
import { addDaysYmd, monthRange, parseYmd } from './attendance-status';

/**
 * Pure helpers for the shift scheduling UI (step 8.2) — calendar arithmetic on YYYY-MM-DD strings
 * (UTC, so the browser zone can never shift a day) and the one client-side mirror of the backend's
 * `scheduleDay()` precedence (apps/api/src/scheduling/scheduling-day.util.ts) so the roster grid,
 * "My schedule" and the attendance graph never disagree about what a day is.
 */

export type ViewMode = 'week' | 'month';

/** Sunday-first week containing `ymd` (the attendance graph's convention; the grid mirrors itself under RTL). */
export function weekStart(ymd: string): string {
  return addDaysYmd(ymd, -parseYmd(ymd).getUTCDay());
}

export function windowFor(anchor: string, mode: ViewMode): { from: string; to: string } {
  if (mode === 'week') {
    const from = weekStart(anchor);
    return { from, to: addDaysYmd(from, 6) };
  }
  const { from, to } = monthRange(anchor.slice(0, 7));
  return { from, to };
}

/** Step the anchor by one window (a week, or a calendar month). */
export function stepAnchor(anchor: string, mode: ViewMode, delta: 1 | -1): string {
  if (mode === 'week') return addDaysYmd(anchor, 7 * delta);
  const d = parseYmd(`${anchor.slice(0, 7)}-01`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

export const weekdayName = (ymd: string): string => WEEKDAYS[parseYmd(ymd).getUTCDay()] as string;

export interface DayInput {
  cell: { dayOff: boolean; shiftId: string | null } | null;
  standingShiftId: string | null;
  isWeekend: boolean;
  isHoliday: boolean;
  onLeave: boolean;
}

export interface DayResolved {
  kind: ScheduleDayKind;
  shiftId: string | null;
  via: 'ROSTER' | 'STANDING' | null;
}

/** Mirror of the API's `scheduleDay()`: day off > (weekend/holiday unless a shift is ROSTERED) > leave > roster > standing > default. */
export function resolveDay(i: DayInput): DayResolved {
  const rostered = i.cell && !i.cell.dayOff ? i.cell.shiftId : null;
  if (i.cell?.dayOff) return { kind: 'DAY_OFF', shiftId: null, via: 'ROSTER' };
  if (!rostered && i.isWeekend) return { kind: 'WEEKEND', shiftId: null, via: null };
  if (!rostered && i.isHoliday) return { kind: 'HOLIDAY', shiftId: null, via: null };
  if (i.onLeave) return { kind: 'LEAVE', shiftId: rostered ?? i.standingShiftId, via: rostered ? 'ROSTER' : i.standingShiftId ? 'STANDING' : null };
  if (rostered) return { kind: 'SHIFT', shiftId: rostered, via: 'ROSTER' };
  if (i.standingShiftId) return { kind: 'SHIFT', shiftId: i.standingShiftId, via: 'STANDING' };
  return { kind: 'DEFAULT_HOURS', shiftId: null, via: null };
}

/** An end at/before the start means the shift runs past midnight. */
export const isOvernight = (startTime: string, endTime: string): boolean => endTime <= startTime;

/** Fallback chip colour when a shift has none (the design system's accent green). */
export const DEFAULT_SHIFT_COLOR = '#2e9e7e';

/** Tinted chip background from a #rrggbb colour (15% alpha — text stays the theme's ink colour, so contrast holds in light and dark). */
export const tint = (color: string | null | undefined, alphaHex = '26'): string => `${color ?? DEFAULT_SHIFT_COLOR}${alphaHex}`;

export function formatDayLong(ymd: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(parseYmd(ymd));
}
export function formatDayShort(ymd: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(parseYmd(ymd));
}
export function formatWindowTitle(from: string, to: string, mode: ViewMode, locale: string): string {
  if (mode === 'month') return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseYmd(from));
  const f = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const y = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${f.format(parseYmd(from))} – ${y.format(parseYmd(to))}`;
}
