'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { useSession } from '../../lib/session/SessionProvider';
import { useAsync } from '../../lib/useAsync';
import { listEmployees } from '../../lib/api/employees';
import { getAttendanceStatus, type AttendanceDayStatus, type ClassifiedAttendanceDay } from '../../lib/api/attendance-status';
import { formatTime } from '../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { Select } from '../ui/Select';
import { Alert } from '../ui/Alert';
import { PageSpinner } from '../ui/Spinner';

/**
 * Step 8.1 Part 3 — a color-coded monthly attendance calendar, driven
 * entirely by `GET /attendance/status` (Part 2, docs/conventions/
 * attendance-status.md): this component classifies NOTHING itself, it
 * renders the `days[]`/`summary` the server already computed. See
 * docs/conventions/attendance-ui.md for the full write-up (RTL mirroring,
 * the reason->string map, the manager/HR picker).
 */

const STATUS_ORDER: AttendanceDayStatus[] = ['GREEN', 'YELLOW', 'RED', 'NEUTRAL', 'IN_PROGRESS'];

const STATUS_CELL_CLASSES: Record<AttendanceDayStatus, string> = {
  GREEN: 'bg-brand-50 text-brand-800 ring-brand-200 hover:bg-brand-100',
  YELLOW: 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100',
  RED: 'bg-coral-50 text-coral-700 ring-coral-200 hover:bg-coral-100',
  NEUTRAL: 'bg-sand-100 text-ink-400 ring-ink-200 hover:bg-sand-200',
  // sky/info tone (verified AA contrast, design-system.md § Contrast) — there is no
  // verified `accent-*` text/background pairing, so the "live today" state is only
  // conveyed by the decorative (aria-hidden) accent pulse dot below, not text color.
  IN_PROGRESS: 'bg-sky-50 text-sky-800 ring-sky-300 hover:bg-sky-100',
};

const LEGEND_DOT_CLASSES: Record<AttendanceDayStatus, string> = {
  GREEN: 'bg-brand-500',
  YELLOW: 'bg-amber-500',
  RED: 'bg-coral-500',
  NEUTRAL: 'bg-ink-300',
  IN_PROGRESS: 'bg-accent-500',
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function monthRange(year: number, month: number): { from: string; to: string; daysInMonth: number; firstWeekday: number } {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return { from: `${year}-${pad(month + 1)}-01`, to: `${year}-${pad(month + 1)}-${pad(daysInMonth)}`, daysInMonth, firstWeekday };
}

/** Localized Sun..Sat short labels — a plain reference week (2023-01-01 was a Sunday); order never changes, RTL mirrors the whole grid via CSS direction. */
function weekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale.replace('_', '-'), { weekday: 'short', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2023, 0, 1 + i))));
}

/**
 * A day cell is its own tooltip trigger — the tooltip `<span>` is an
 * ABSOLUTELY-POSITIONED child of the `<button>`, not a sibling inside an
 * extra wrapping element (unlike `../ui/Tooltip`, whose `inline-flex`
 * wrapper would otherwise shrink-wrap this button to its text content
 * instead of letting the grid track size it — `w-full`/`aspect-square`
 * need a plain block-level grid item). Visually matches `../ui/Tooltip`
 * (same classes), scoped locally for that reason.
 */
function DayCell({
  dateStr,
  day,
  t,
  locale,
}: {
  dateStr: string;
  day: ClassifiedAttendanceDay | undefined;
  t: (k: string, v?: Record<string, unknown>) => string;
  locale: string;
}) {
  const cellClass = day ? STATUS_CELL_CLASSES[day.status] : 'bg-surface ring-ink-100 text-ink-300';
  const tooltipId = `attendance-day-tip-${dateStr}`;
  return (
    <button
      type="button"
      data-testid={`attendance-day-${dateStr}`}
      data-status={day?.status ?? 'UNKNOWN'}
      aria-label={`${dateStr}${day ? ` — ${t(`attendance.dayStatus.${day.status}`)}` : ''}`}
      aria-describedby={day ? tooltipId : undefined}
      className={`group/tip relative flex aspect-square w-full items-center justify-center rounded-lg text-sm font-medium ring-1 ring-inset transition-colors ${cellClass}`}
    >
      {Number(dateStr.slice(-2))}
      {day?.status === 'IN_PROGRESS' && (
        <span className="absolute end-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-accent-500 motion-reduce:animate-none" aria-hidden />
      )}
      {day && (
        <span
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none absolute bottom-full start-1/2 z-40 mb-1.5 w-max max-w-[16rem] -translate-x-1/2 rounded-md bg-sidebar px-2 py-1.5 text-start text-xs font-medium normal-case tracking-normal text-sidebar-fg opacity-0 shadow-pop transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 rtl:translate-x-1/2"
        >
          <span className="block font-semibold">{day.date}</span>
          <span className="block">
            {t('attendance.graph.checkIn')}: {day.clockIn ? formatTime(day.clockIn, locale) : t('attendance.graph.noPunch')}
          </span>
          <span className="block">
            {t('attendance.graph.checkOut')}: {day.clockOut ? formatTime(day.clockOut, locale) : t('attendance.graph.noPunch')}
          </span>
          <span className="block">
            {t('attendance.graph.hoursWorked')} {day.hoursWorked}h / {t('attendance.graph.hoursRequired')} {day.requiredHours}h
          </span>
          <span className="block">{day.reasons.map((r) => t(`attendance.reason.${r}`)).join(' · ')}</span>
        </span>
      )}
    </button>
  );
}

export function MonthlyAttendanceGraph() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const { employee } = useSession();
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getUTCFullYear(), month: now.getUTCMonth() });
  const [employeeId, setEmployeeId] = useState('');

  const canViewOthers = can(PERMISSIONS.ATTENDANCE_APPROVE) || can(PERMISSIONS.WORKING_HOURS_MANAGE);
  const { data: pickerEmployees } = useAsync(
    () => (canViewOthers ? listEmployees({ pageSize: 200 }).then((r) => r.data) : Promise.resolve([])),
    [canViewOthers],
  );

  const { from, to, daysInMonth, firstWeekday } = useMemo(() => monthRange(cursor.year, cursor.month), [cursor]);
  const { data: status, loading, error } = useAsync(
    () => getAttendanceStatus({ employeeId: employeeId || undefined, from, to }),
    [employeeId, from, to],
  );

  const byDate = useMemo(() => {
    const map = new Map<string, ClassifiedAttendanceDay>();
    for (const d of status?.days ?? []) map.set(d.date, d);
    return map;
  }, [status]);

  const monthLabel = new Intl.DateTimeFormat(locale.replace('_', '-'), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(cursor.year, cursor.month, 1)),
  );
  const weekdays = useMemo(() => weekdayLabels(locale), [locale]);
  const pickedEmployee = pickerEmployees?.find((e) => e.id === employeeId) ?? null;

  function shiftMonth(delta: number) {
    setCursor((c) => {
      const d = new Date(Date.UTC(c.year, c.month + delta, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });
  }

  return (
    <Card>
      <CardHeader className="flex-wrap gap-3">
        <CardTitle>{t('attendance.graph.title')}</CardTitle>
        <div className="flex items-center gap-2" data-testid="attendance-month-nav">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label={t('attendance.graph.prevMonth')}
            data-testid="attendance-prev-month"
            className="rounded-lg border border-ink-200 p-1.5 text-ink-500 hover:bg-sand-100"
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
          </button>
          <span className="min-w-[9rem] text-center text-sm font-semibold text-ink-800" data-testid="attendance-month-label">
            {monthLabel}
          </span>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label={t('attendance.graph.nextMonth')}
            data-testid="attendance-next-month"
            className="rounded-lg border border-ink-200 p-1.5 text-ink-500 hover:bg-sand-100"
          >
            <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
          </button>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {canViewOthers && (
          <div className="flex items-center gap-3">
            <label htmlFor="attendance-member-picker" className="shrink-0 text-sm font-medium text-ink-700">
              {t('attendance.graph.pickMember')}
            </label>
            <div className="w-full max-w-xs">
              <Select
                id="attendance-member-picker"
                searchable
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                data-testid="attendance-member-picker"
              >
                <option value="">{t('attendance.graph.pickMemberPlaceholder')}</option>
                {(pickerEmployees ?? [])
                  .filter((e) => e.id !== employee?.id)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.firstName} {e.lastName} ({e.employeeCode})
                    </option>
                  ))}
              </Select>
            </div>
          </div>
        )}

        <p className="text-sm text-ink-500" data-testid="attendance-viewing-label">
          {pickedEmployee ? t('attendance.graph.viewingMember', { name: `${pickedEmployee.firstName} ${pickedEmployee.lastName}` }) : t('attendance.graph.viewingSelf')}
        </p>

        {error && <Alert tone="error">{error}</Alert>}

        {loading && !status ? (
          <PageSpinner />
        ) : status ? (
          <div className="space-y-4">
            <div className="grid grid-cols-7 gap-1.5 text-center text-xs font-semibold uppercase tracking-wide text-ink-400" data-testid="attendance-weekday-header">
              {weekdays.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1.5" data-testid="attendance-month-grid">
              {Array.from({ length: firstWeekday }, (_, i) => (
                <div key={`lead-${i}`} aria-hidden />
              ))}
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((dayNum) => {
                const dateStr = `${cursor.year}-${pad(cursor.month + 1)}-${pad(dayNum)}`;
                return <DayCell key={dateStr} dateStr={dateStr} day={byDate.get(dateStr)} t={t} locale={locale} />;
              })}
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-100 pt-4" aria-label={t('attendance.graph.legend')} data-testid="attendance-legend">
              {STATUS_ORDER.map((s) => (
                <span key={s} className="inline-flex items-center gap-1.5 text-xs text-ink-600" data-testid={`attendance-legend-${s}`}>
                  <span className={`h-2.5 w-2.5 rounded-full ${LEGEND_DOT_CLASSES[s]}`} aria-hidden />
                  {t(`attendance.dayStatus.${s}`)} ({status.summary[s] ?? 0})
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
