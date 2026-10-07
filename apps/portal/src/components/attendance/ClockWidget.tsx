'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, LogIn, LogOut } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { clockIn, clockOut } from '../../lib/api/attendance';
import { getAttendanceStatus, type ClassifiedAttendanceDay } from '../../lib/api/attendance-status';
import { getCurrentCoordinates } from '../../lib/geolocation';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { formatTime } from '../../lib/format';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { PageSpinner } from '../ui/Spinner';
import { StatusBadge } from '../ui/Badge';
import { LiveAnalogClock } from './LiveAnalogClock';
import { GoalRing } from './GoalRing';

/**
 * Step 8.1 Part 3 — the live clock widget on `/dashboard` and `/attendance`
 * (docs/conventions/attendance-ui.md). Consumes `GET /attendance/status`
 * (Part 2) as the single source of truth for "am I clocked in and what does
 * today look like" — it never reclassifies a day itself. Re-fetches on every
 * clock-in/out and on a plain interval (nothing is cached server-side either).
 */
const STATUS_RELOAD_MS = 60_000;

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatHoursMinutes(hours: number): string {
  const totalMinutes = Math.round(Math.max(0, hours) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

export function ClockWidget({ locale }: { locale: string }) {
  const { t } = useI18n();
  // A 3-day window (yesterday/today/tomorrow, the viewer's own browser-local
  // dates) rather than just "today": the member's BRANCH-local day can differ
  // from the browser's by up to a day at the edges, and an IN_PROGRESS shift
  // started just before local midnight must still be found. See
  // docs/conventions/attendance-ui.md's "Known gaps" for the honest caveat.
  const { data: status, loading, reload } = useAsync(() => getAttendanceStatus({ from: dateOffset(-1), to: dateOffset(1) }), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(reload, STATUS_RELOAD_MS);
    return () => clearInterval(id);
  }, [reload]);

  const today: ClassifiedAttendanceDay | undefined =
    status?.days.find((d) => d.status === 'IN_PROGRESS') ?? status?.days.find((d) => d.date === dateOffset(0));
  const inProgress = today?.status === 'IN_PROGRESS';

  // Ticks the elapsed-time display once a second while a shift is open — the
  // ANCHOR (`today.clockIn`) is the server's own instant; only "now" is local.
  useEffect(() => {
    if (!inProgress) return;
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [inProgress]);

  const requiredHours = status?.policy.requiredHours ?? 0;
  const elapsedHours = inProgress && today?.clockIn ? (now.getTime() - new Date(today.clockIn).getTime()) / 3_600_000 : (today?.hoursWorked ?? 0);
  const progress = requiredHours > 0 ? elapsedHours / requiredHours : 0;
  const remainingHours = Math.max(0, requiredHours - elapsedHours);
  const overGoalHours = Math.max(0, elapsedHours - requiredHours);

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
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !status) return <PageSpinner />;

  return (
    <div className="space-y-4" data-testid="clock-widget" data-day-status={today?.status ?? 'NONE'}>
      {inProgress && today ? (
        <div
          className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:justify-center sm:gap-8"
          data-testid="live-clock-section"
          aria-live="off"
        >
          <LiveAnalogClock size={148} />
          <GoalRing progress={progress} size={148}>
            <div className="text-center">
              <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-ink-400">{t('attendance.clock.elapsed')}</p>
              <p className="text-lg font-bold tabular-nums text-ink-900" data-testid="clock-elapsed">
                {formatHoursMinutes(elapsedHours)}
              </p>
              <p className="text-xs text-ink-500" data-testid="clock-remaining">
                {overGoalHours > 0.001 ? t('attendance.clock.overGoal', { time: formatHoursMinutes(overGoalHours) }) : `${formatHoursMinutes(remainingHours)} ${t('attendance.clock.remaining')}`}
              </p>
            </div>
          </GoalRing>
          <div className="text-center sm:text-start">
            {/* sky/info tone (verified AA contrast, design-system.md § Contrast) — not `accent-*` text, which has no verified contrast pairing; the accent dot stays purely decorative (aria-hidden). */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700 ring-1 ring-inset ring-sky-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-500 motion-reduce:animate-none" aria-hidden />
              {t('attendance.clock.liveBadge')}
            </span>
            <p className="mt-2 text-sm text-ink-600">{t('attendance.clock.clockedInSince', { time: formatTime(today.clockIn, locale) })}</p>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5" data-testid="idle-clock-section">
          {today && today.clockOut ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink-500">{t('attendance.clock.today')}:</span>
              <StatusBadge status={today.status} label={t(`attendance.dayStatus.${today.status}`)} />
              <span className="text-sm text-ink-600">{t(`attendance.reason.${today.reason}`)}</span>
              {today.isHalfDay && <span className="text-xs font-medium text-coral-600">{t('attendance.clock.halfDay')}</span>}
              {!today.isHalfDay && today.isShortDay && <span className="text-xs font-medium text-coral-600">{t('attendance.clock.shortDay')}</span>}
            </div>
          ) : (
            <p className="text-sm text-ink-500" data-testid="not-clocked-in-today">
              {t('attendance.clock.notClockedInToday')}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          data-testid="clock-toggle-button"
          onClick={() => handleClock(inProgress ? 'out' : 'in')}
          loading={busy}
          variant={inProgress ? 'danger' : 'primary'}
        >
          {inProgress ? <LogOut className="h-4 w-4" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
          {inProgress ? t('attendance.clockOut') : t('attendance.clockIn')}
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
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="user"
          className="hidden"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
    </div>
  );
}
