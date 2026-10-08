import type { ClassifiedDay, DayReason, DayStatus } from './api/attendance';

/**
 * Pure helpers for the Part-3 clock + monthly graph (docs/conventions/attendance-ui.md).
 * Everything here is calendar arithmetic on `YYYY-MM-DD` strings (done in UTC so the
 * browser's own timezone can never shift a day) — classification itself is the server's.
 */

export const DAY_STATUS_ORDER: DayStatus[] = ['GREEN', 'YELLOW', 'RED', 'NEUTRAL', 'IN_PROGRESS'];

/** The branch-local calendar day of an instant, in the given IANA timezone (en-CA formats as YYYY-MM-DD). */
export function ymdInTimeZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseYmd(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

export function addDaysYmd(ymd: string, days: number): string {
  return ymdUtc(new Date(parseYmd(ymd).getTime() + days * 86_400_000));
}

/** `YYYY-MM` of a day. */
export function monthKey(ymd: string): string {
  return ymd.slice(0, 7);
}

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(key: string): { from: string; to: string; days: number } {
  const [y, m] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}`, days: last };
}

/**
 * The calendar grid for a month: weeks of 7 cells (null = padding outside the month), logical order —
 * index 0 is the first day of the week and the CSS grid places it at the inline START, so under
 * `dir="rtl"` the week starts on the RIGHT and the order mirrors with zero direction-specific code.
 * `weekStart` is 0 = Sunday … 6 = Saturday.
 */
export function buildMonthGrid<T extends { date: string }>(key: string, days: T[], weekStart = 0): (T | null)[][] {
  const { from, days: count } = monthRange(key);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const lead = (parseYmd(from).getUTCDay() - weekStart + 7) % 7;
  const cells: (T | null)[] = Array.from({ length: lead }, () => null);
  for (let i = 0; i < count; i += 1) cells.push(byDate.get(addDaysYmd(from, i)) ?? null);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (T | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** i18n key for a reason code (every code the API can emit has a `attendance.reason.*` message). */
export function reasonKey(reason: DayReason): string {
  return `attendance.reason.${reason}`;
}

/** Short-day / half-day callout for a finished (RED) day, else null. */
export function shortfallKind(day: Pick<ClassifiedDay, 'isHalfDay' | 'isShortDay' | 'isEarlyOut'>): 'HALF_DAY' | 'SHORT_DAY' | null {
  if (day.isHalfDay) return 'HALF_DAY';
  if (day.isShortDay || day.isEarlyOut) return 'SHORT_DAY';
  return null;
}

/**
 * Tailwind classes per status. Solid fills use the tokens that stay dark under white text in BOTH
 * themes (`primary`/`danger`, design-system.md § 2); NEUTRAL is a dashed muted cell so it can never
 * be read as good OR bad; IN_PROGRESS is a surface cell with a live accent ring.
 */
export const STATUS_CELL_CLASS: Record<DayStatus, string> = {
  GREEN: 'bg-primary text-white',
  YELLOW: 'bg-amber-400 text-[#1d1a0e]',
  RED: 'bg-danger text-white',
  NEUTRAL: 'bg-sand-100 text-ink-400 border border-dashed border-ink-200',
  IN_PROGRESS: 'bg-surface text-ink-900 ring-2 ring-accent-500',
};

/** Legend swatches (same colours, no text). */
export const STATUS_SWATCH_CLASS: Record<DayStatus, string> = {
  GREEN: 'bg-primary',
  YELLOW: 'bg-amber-400',
  RED: 'bg-danger',
  NEUTRAL: 'bg-sand-100 border border-dashed border-ink-300',
  IN_PROGRESS: 'bg-surface ring-2 ring-accent-500',
};
