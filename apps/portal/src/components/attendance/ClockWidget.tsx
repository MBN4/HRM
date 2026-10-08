'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, CheckCircle2, LogIn, LogOut, TriangleAlert } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { clockIn, clockOut, getAttendanceStatus, type AttendanceStatusResult, type ClassifiedDay } from '../../lib/api/attendance';
import { addDaysYmd, reasonKey, shortfallKind, ymdInTimeZone, ymdUtc } from '../../lib/attendance-status';
import { getCurrentCoordinates } from '../../lib/geolocation';
import { ApiError } from '../../lib/api/client';
import { formatDate, formatTime } from '../../lib/format';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { PageSpinner } from '../ui/Spinner';
import { AnalogClock, useNow } from './AnalogClock';

const REFRESH_MS = 60_000;
/** Beyond this the browser clock is considered skewed vs the server and `elapsed` is corrected (see `skewMs`). */
const SKEW_TOLERANCE_MS = 120_000;

const STATUS_TONE = { GREEN: 'success', YELLOW: 'warning', RED: 'danger', NEUTRAL: 'neutral', IN_PROGRESS: 'info' } as const;

function hms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
}

function hoursLabel(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/**
 * Step 8.1 Part 3 — today's attendance card: the live analog clock + running elapsed/goal progress while
 * clocked in, the resulting day-status after clock-out, the clock-in control otherwise.
 *
 * The SERVER decides state: `GET /attendance/status` (Part 2) is re-fetched on mount, after every clock
 * in/out, every minute, and on tab focus. Between fetches only `now` ticks client-side; `elapsed` is always
 * `now − server clockIn` (never an accumulated counter), and if the browser clock disagrees with the
 * server by more than a couple of minutes the difference is measured at fetch time and corrected.
 * See docs/conventions/attendance-ui.md.
 */
export function ClockWidget({ locale, onClockEvent }: { locale: string; onClockEvent?: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<AttendanceStatusResult | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      // UTC-today ±(7|1) always spans the branch-local "today" (offsets are ≤ ±14h) and gives us the last
      // few days to show "last day's status" when today has no record yet. One call, ≤ 9 days.
      const utcToday = ymdUtc(new Date());
      const result = await getAttendanceStatus({ from: addDaysYmd(utcToday, -7), to: addDaysYmd(utcToday, 1) });
      setStatus(result);
      setFetchedAt(Date.now());
      setError((e) => (e && e.startsWith('status:') ? null : e));
    } catch (err) {
      // A caller without a linked Employee record (or attendance.read) simply has no status — the clock controls still work/fail on their own.
      if (!(err instanceof ApiError) || err.status >= 500) setError('status:' + t('error.generic'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const timeZone = status?.timezone ?? 'UTC';
  const live: ClassifiedDay | null = useMemo(() => status?.days.find((d) => d.status === 'IN_PROGRESS') ?? null, [status]);
  const today = useMemo(() => {
    if (!status) return null;
    const ymd = ymdInTimeZone(new Date(fetchedAt || Date.now()), status.timezone);
    return status.days.find((d) => d.date === ymd) ?? null;
  }, [status, fetchedAt]);
  const lastDay = useMemo(() => {
    if (!status || !today) return null;
    return [...status.days].reverse().find((d) => d.date < today.date && d.status !== 'NEUTRAL') ?? null;
  }, [status, today]);

  const clockedIn = live?.clockIn != null;
  const required = status?.policy.requiredHours ?? 0;
  const requiredMs = required * 3_600_000;

  // Measured once per fetch: how far the browser clock is from the server's (hoursWorked is the server's elapsed at fetch time).
  const skewMs = useMemo(() => {
    if (!live?.clockIn || live.hoursWorked == null || !fetchedAt) return 0;
    const diff = fetchedAt - new Date(live.clockIn).getTime() - live.hoursWorked * 3_600_000;
    return Math.abs(diff) > SKEW_TOLERANCE_MS ? diff : 0;
  }, [live, fetchedAt]);

  const now = useNow(false);
  const elapsedMs = live?.clockIn ? Math.max(0, now.getTime() - skewMs - new Date(live.clockIn).getTime()) : 0;
  const progress = requiredMs > 0 ? elapsedMs / requiredMs : 0;
  const remainingMs = Math.max(0, requiredMs - elapsedMs);
  const overtimeMs = Math.max(0, elapsedMs - requiredMs);

  async function handleClock(direction: 'in' | 'out') {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const coords = await getCurrentCoordinates();
      const action = direction === 'in' ? clockIn : clockOut;
      await action({ source: 'WEB', lat: coords?.lat, long: coords?.long, photo });
      setSuccess(direction === 'in' ? t('attendance.clockInSuccess') : t('attendance.clockOutSuccess'));
      setPhoto(null);
      await refresh();
      onClockEvent?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageSpinner />;

  const controls = (
    <div className="flex items-center gap-2">
      <Button data-testid="clock-toggle-button" onClick={() => handleClock(clockedIn ? 'out' : 'in')} loading={busy} variant={clockedIn ? 'danger' : 'primary'}>
        {clockedIn ? <LogOut className="h-4 w-4" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
        {clockedIn ? t('attendance.clockOut') : t('attendance.clockIn')}
      </Button>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className={`rounded-lg border p-2 ${photo ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-400 hover:bg-sand-100'}`}
        title={t('attendance.photo')}
        aria-label={t('attendance.photo')}
        aria-pressed={!!photo}
      >
        <Camera className="h-4 w-4" aria-hidden />
      </button>
      <input ref={fileInputRef} type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
    </div>
  );

  const feedback = (
    <>
      {error && !error.startsWith('status:') && <Alert tone="error">{error}</Alert>}
      {error?.startsWith('status:') && <Alert tone="error">{error.slice(7)}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
    </>
  );

  // ---- clocked in: the live clock ----------------------------------------------------------------------
  if (clockedIn && live?.clockIn) {
    const goalReached = requiredMs > 0 && elapsedMs >= requiredMs;
    return (
      <div data-testid="clock-live" data-state="in-progress" className="space-y-4">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
          <AnalogClock timeZone={timeZone} progress={requiredMs > 0 ? progress : undefined} live label={t('attendance.live.clockLabel', { zone: timeZone })} />
          <div className="min-w-0 flex-1 space-y-3 text-center sm:text-start">
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              <Badge tone="info">
                <span className="me-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent-500 motion-safe:animate-pulse" aria-hidden />
                {t('attendance.live.inProgress')}
              </Badge>
              <span className="text-xs text-ink-500">{t('attendance.clockedInSince', { time: formatTime(live.clockIn, locale) })}</span>
            </div>
            <div>
              <p className="eyebrow">{t('attendance.live.elapsed')}</p>
              <p dir="ltr" data-testid="clock-elapsed" className="text-4xl font-bold tabular-nums tracking-tight text-ink-900 sm:text-start">
                {hms(elapsedMs)}
              </p>
            </div>
            {requiredMs > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-ink-600">{t('attendance.live.goal', { hours: required })}</span>
                  <span data-testid="clock-remaining" className="font-semibold text-ink-900">
                    {goalReached ? t('attendance.live.goalReached') : t('attendance.live.remaining', { time: hoursLabel(remainingMs) })}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label={t('attendance.live.progress')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, Math.round(progress * 100))}
                  className="h-2 overflow-hidden rounded-full bg-sand-200"
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent-400 to-brand-500 motion-safe:transition-[width] motion-safe:duration-1000"
                    style={{ width: `${Math.min(100, progress * 100)}%` }}
                  />
                </div>
                {overtimeMs > 0 && <p className="text-xs text-brand-700">{t('attendance.live.overtime', { time: hoursLabel(overtimeMs) })}</p>}
              </div>
            )}
          </div>
        </div>
        {controls}
        {feedback}
      </div>
    );
  }

  // ---- not clocked in: today's resulting status (after clock-out) or the idle state -------------------
  const done = today && today.clockIn && today.clockOut ? today : null;
  const shortfall = done ? shortfallKind(done) : null;
  return (
    <div data-testid="clock-idle" data-state={done ? 'done' : 'idle'} className="space-y-4">
      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
        <AnalogClock timeZone={timeZone} label={t('attendance.live.clockLabel', { zone: timeZone })} />
        <div className="min-w-0 flex-1 space-y-3 text-center sm:text-start">
          {done ? (
            <>
              <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                <Badge tone={STATUS_TONE[done.status]}>
                  <span data-testid="clock-day-status" data-status={done.status}>
                    {t(`attendance.dayStatus.${done.status}`)}
                  </span>
                </Badge>
                {shortfall && (
                  <Badge tone="danger">
                    <TriangleAlert className="me-1 h-3 w-3" aria-hidden />
                    <span data-testid="clock-shortfall" data-kind={shortfall}>
                      {t(`attendance.reason.${shortfall}`)}
                    </span>
                  </Badge>
                )}
              </div>
              <p className="text-sm text-ink-700">{t(reasonKey(done.reason))}</p>
              <p className="text-sm text-ink-600">
                <span dir="ltr">
                  {formatTime(done.clockIn, locale)} – {formatTime(done.clockOut, locale)}
                </span>
                {' · '}
                {t('attendance.tooltip.hours', { worked: (done.hoursWorked ?? 0).toFixed(1), required: (done.requiredHours ?? 0).toFixed(1) })}
              </p>
              <p className="flex items-center justify-center gap-1.5 text-xs text-ink-400 sm:justify-start">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                {t('attendance.live.doneForToday')}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-ink-800">{t('attendance.notClockedIn')}</p>
              {today && (
                <p className="text-xs text-ink-500">
                  {t('attendance.live.today')}: {t(reasonKey(today.reason))}
                </p>
              )}
              {lastDay && (
                <p data-testid="clock-last-day" className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-ink-500 sm:justify-start">
                  <span>{t('attendance.live.lastDay', { date: formatDate(`${lastDay.date}T12:00:00Z`, locale) })}</span>
                  <Badge tone={STATUS_TONE[lastDay.status]}>{t(`attendance.dayStatus.${lastDay.status}`)}</Badge>
                </p>
              )}
              {status && <p className="text-xs text-ink-400">{t('attendance.live.shiftStarts', { time: status.policy.startTime, hours: required })}</p>}
            </>
          )}
        </div>
      </div>
      {controls}
      {feedback}
    </div>
  );
}
