'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Minus, TriangleAlert, X } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { getAttendanceStatus, type AttendanceStatusResult, type ClassifiedDay, type DayStatus } from '../../lib/api/attendance';
import { ApiError } from '../../lib/api/client';
import {
  buildMonthGrid,
  DAY_STATUS_ORDER,
  monthKey,
  monthRange,
  parseYmd,
  reasonKey,
  shiftMonth,
  STATUS_CELL_CLASS,
  STATUS_SWATCH_CLASS,
  ymdInTimeZone,
} from '../../lib/attendance-status';
import { formatTime } from '../../lib/format';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { PageSpinner } from '../ui/Spinner';

const GLYPH: Record<DayStatus, typeof Check | null> = { GREEN: Check, YELLOW: TriangleAlert, RED: X, NEUTRAL: Minus, IN_PROGRESS: null };

/** Locale-formatted month title / weekday headers, built from fixed UTC dates so the browser timezone can't shift them. */
function monthTitle(key: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseYmd(`${key}-01`));
}
function weekdayLabels(locale: string, weekStart: number): { long: string; short: string }[] {
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(2023, 0, 1 + ((weekStart + i) % 7)));
    return {
      long: new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(d),
      short: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(d),
    };
  });
}

// Logical alignment: the first/last column's tooltip hangs from the cell's inline start/end so it never leaves the card; middle columns centre (and mirror under RTL).
const ALIGN_CLASS = { start: 'start-0', end: 'end-0', center: 'start-1/2 -translate-x-1/2 rtl:translate-x-1/2' } as const;

function DayTooltip({ day, locale, id, align }: { day: ClassifiedDay; locale: string; id: string; align: 'start' | 'center' | 'end' }) {
  const { t } = useI18n();
  const reasons = day.reasons.length > 0 ? day.reasons : [day.reason];
  return (
    <div
      id={id}
      role="tooltip"
      data-testid={`day-tooltip-${day.date}`}
      className={`pointer-events-none invisible absolute bottom-full z-30 mb-2 w-56 rounded-lg bg-sidebar p-3 text-start text-xs text-sidebar-fg opacity-0 shadow-pop transition-opacity duration-150 ${ALIGN_CLASS[align]} group-focus-within/day:visible group-focus-within/day:opacity-100 group-hover/day:visible group-hover/day:opacity-100`}
    >
      <p className="mb-1 font-semibold">
        {new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(parseYmd(day.date))}
        {' · '}
        {t(`attendance.dayStatus.${day.status}`)}
      </p>
      <ul className="mb-1.5 list-disc space-y-0.5 ps-4">
        {reasons.map((r) => (
          <li key={r}>{t(reasonKey(r))}</li>
        ))}
      </ul>
      {(day.clockIn || day.clockOut) && (
        <dl className="space-y-0.5 opacity-90">
          <div className="flex justify-between gap-3">
            <dt>{t('attendance.clockIn')}</dt>
            <dd dir="ltr">{formatTime(day.clockIn, locale)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>{t('attendance.clockOut')}</dt>
            <dd dir="ltr">{day.clockOut ? formatTime(day.clockOut, locale) : '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>{t('attendance.worked')}</dt>
            <dd>{t('attendance.tooltip.hours', { worked: (day.hoursWorked ?? 0).toFixed(1), required: (day.requiredHours ?? 0).toFixed(1) })}</dd>
          </div>
          {day.minutesLate > 0 && (
            <div className="flex justify-between gap-3">
              <dt>{t('attendance.late')}</dt>
              <dd>{t('attendance.tooltip.minutes', { n: day.minutesLate })}</dd>
            </div>
          )}
          {day.minutesEarly > 0 && (
            <div className="flex justify-between gap-3">
              <dt>{t('attendance.tooltip.early')}</dt>
              <dd>{t('attendance.tooltip.minutes', { n: day.minutesEarly })}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

export interface MonthlyAttendanceGraphProps {
  /** Omit for the caller's own month; a manager/HR passes someone else's id (the API enforces who may). */
  employeeId?: string;
  /** Tighter cells for the dashboard. */
  compact?: boolean;
  /** Re-fetch trigger (e.g. bump after a clock event so today's cell updates). */
  refreshKey?: number;
}

/**
 * Step 8.1 Part 3 — the colour-coded monthly attendance calendar. ONE `GET /attendance/status` call per
 * visible month; every cell's colour comes from the server's `status` (weekends/holidays/leave are NEUTRAL
 * because the API says so — nothing about weekends is hardcoded here), the legend counts are the server's
 * `summary`. RTL needs no special code: the grid is a plain 7-column CSS grid whose logical order is
 * [week-start … week-end]; `dir="rtl"` on <html> places the first column at the right edge.
 * See docs/conventions/attendance-ui.md.
 */
export function MonthlyAttendanceGraph({ employeeId, compact = false, refreshKey = 0 }: MonthlyAttendanceGraphProps) {
  const { t, locale } = useI18n();
  const tipBase = useId();
  const todayYmd = (tz: string) => ymdInTimeZone(new Date(), tz);
  const [month, setMonth] = useState<string | null>(null);

  // First paint: derive the current month in the BRANCH timezone — but the timezone only arrives with the
  // first response, so the very first call uses the browser's month and the grid re-anchors if they differ.
  const initial = useMemo(() => monthKey(ymdInTimeZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)), []);
  const shown = month ?? initial;
  const range = monthRange(shown);

  // Not `useAsync`: we need the HTTP status to tell "you may not view this person" (403/404, a normal outcome of the
  // picker) from a genuine failure. Keeps the previous month on screen (dimmed) while the next one loads.
  const [state, setState] = useState<{ data: AttendanceStatusResult | null; loading: boolean; error: string | null; denied: boolean }>({
    data: null,
    loading: true,
    error: null,
    denied: false,
  });
  const [attempt, setAttempt] = useState(0);
  const reload = () => setAttempt((n) => n + 1);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null, denied: false }));
    getAttendanceStatus({ employeeId, from: range.from, to: range.to })
      .then((data) => !cancelled && setState({ data, loading: false, error: null, denied: false }))
      .catch((err) => {
        if (cancelled) return;
        const denied = err instanceof ApiError && (err.status === 403 || err.status === 404);
        setState({ data: null, loading: false, denied, error: denied ? null : err instanceof ApiError ? err.message : t('error.generic') });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, shown, refreshKey, attempt]);
  const { data, loading, error, denied } = state;

  useEffect(() => setMonth(null), [employeeId]);
  // The first request used the browser's month; once the branch timezone is known, snap to ITS current month if they differ.
  useEffect(() => {
    if (month === null && data && todayYmd(data.timezone) && monthKey(todayYmd(data.timezone)) !== initial) setMonth(monthKey(todayYmd(data.timezone)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const weekStart = 0; // Sunday-first; the grid mirrors itself under RTL (the Country Pack's first-day-of-week isn't exposed by the status endpoint)
  const weeks = useMemo(() => buildMonthGrid(shown, data?.days ?? [], weekStart), [shown, data]);
  const labels = useMemo(() => weekdayLabels(locale, weekStart), [locale]);
  const today = data ? todayYmd(data.timezone) : null;
  const atCurrentMonth = today ? monthKey(today) === shown : shown === initial;

  return (
    <div data-testid="monthly-graph" data-month={shown} className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" aria-label={t('attendance.month.prev')} data-testid="month-prev" onClick={() => setMonth(shiftMonth(shown, -1))}>
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
          </Button>
          <h3 data-testid="month-title" aria-live="polite" className="min-w-[9rem] text-center text-sm font-semibold text-ink-900">
            {monthTitle(shown, locale)}
          </h3>
          <Button variant="ghost" aria-label={t('attendance.month.next')} data-testid="month-next" onClick={() => setMonth(shiftMonth(shown, 1))}>
            <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
          </Button>
        </div>
        {!atCurrentMonth && (
          <Button variant="secondary" data-testid="month-today" onClick={() => setMonth(null)}>
            {t('attendance.month.today')}
          </Button>
        )}
      </div>

      {denied && <Alert tone="info">{t('attendance.month.forbidden')}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      {denied ? null : loading && !data ? (
        <PageSpinner />
      ) : (
        <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={loading}>
          <div role="grid" aria-label={monthTitle(shown, locale)} className="space-y-1.5" data-testid="month-grid">
            <div role="row" className="grid grid-cols-7 gap-1.5">
              {labels.map((l) => (
                <div key={l.long} role="columnheader" aria-label={l.long} className="pb-1 text-center text-[0.6875rem] font-medium text-ink-400">
                  {l.short}
                </div>
              ))}
            </div>
            {weeks.map((week, w) => (
              <div key={w} role="row" className="grid grid-cols-7 gap-1.5">
                {week.map((day, i) =>
                  day ? (
                    <div key={day.date} role="gridcell" className="group/day relative">
                      <button
                        type="button"
                        data-testid={`day-${day.date}`}
                        data-status={day.status}
                        data-reason={day.reason}
                        aria-describedby={`${tipBase}-${day.date}`}
                        aria-label={`${new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(parseYmd(day.date))}: ${t(`attendance.dayStatus.${day.status}`)} — ${t(reasonKey(day.reason))}`}
                        className={`relative flex w-full flex-col items-center justify-center rounded-lg font-semibold tabular-nums transition-transform hover:scale-105 focus-visible:scale-105 ${
                          compact ? 'aspect-square text-xs' : 'aspect-square min-h-[2.75rem] text-sm'
                        } ${STATUS_CELL_CLASS[day.status]} ${day.date === today ? 'outline outline-2 outline-offset-2 outline-ink-900' : ''}`}
                      >
                        {Number(day.date.slice(8))}
                        {(() => {
                          const Glyph = GLYPH[day.status];
                          return Glyph ? <Glyph className="absolute bottom-0.5 end-0.5 h-2.5 w-2.5 opacity-80" aria-hidden /> : null;
                        })()}
                        {day.status === 'IN_PROGRESS' && <span className="absolute end-1 top-1 h-1.5 w-1.5 rounded-full bg-accent-500 motion-safe:animate-pulse" aria-hidden />}
                      </button>
                      <DayTooltip day={day} locale={locale} id={`${tipBase}-${day.date}`} align={i === 0 ? 'start' : i === 6 ? 'end' : 'center'} />
                    </div>
                  ) : (
                    <div key={`pad-${w}-${i}`} role="gridcell" aria-hidden className="aspect-square" />
                  ),
                )}
              </div>
            ))}
          </div>

          <ul data-testid="month-legend" className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-600">
            {DAY_STATUS_ORDER.filter((s) => s !== 'IN_PROGRESS' || (data?.summary.IN_PROGRESS ?? 0) > 0).map((s) => (
              <li key={s} className="flex items-center gap-1.5" data-testid={`legend-${s}`} data-count={data?.summary[s] ?? 0}>
                <span className={`inline-block h-3 w-3 rounded ${STATUS_SWATCH_CLASS[s]}`} aria-hidden />
                <span>{t(`attendance.dayStatus.${s}`)}</span>
                <span className="font-semibold text-ink-900 tabular-nums">{data?.summary[s] ?? 0}</span>
              </li>
            ))}
          </ul>
          {error && (
            <Button variant="secondary" className="mt-3" onClick={reload}>
              {t('common.retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
