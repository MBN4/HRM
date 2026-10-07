'use client';

import { useRef, useState } from 'react';
import { Camera, LogIn, LogOut } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { clockIn, clockOut, listAttendanceRecords } from '../../lib/api/attendance';
import { getCurrentCoordinates } from '../../lib/geolocation';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { formatTime } from '../../lib/format';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { PageSpinner } from '../ui/Spinner';

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ClockWidget({ locale }: { locale: string }) {
  const { t } = useI18n();
  const { data: records, loading, reload } = useAsync(
    () => listAttendanceRecords({ from: dateOffset(-1), to: dateOffset(1) }),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openRecord = records?.find((r) => r.status === 'OPEN') ?? null;

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

  if (loading) return <PageSpinner />;

  return (
    <div className="space-y-3">
      {openRecord ? (
        <p className="text-sm text-ink-600">{t('attendance.clockedInSince', { time: formatTime(openRecord.clockInAt, locale) })}</p>
      ) : (
        <p className="text-sm text-ink-500">{t('attendance.notClockedIn')}</p>
      )}

      <div className="flex items-center gap-2">
        <Button
          data-testid="clock-toggle-button"
          onClick={() => handleClock(openRecord ? 'out' : 'in')}
          loading={busy}
          variant={openRecord ? 'danger' : 'primary'}
        >
          {openRecord ? <LogOut className="h-4 w-4" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
          {openRecord ? t('attendance.clockOut') : t('attendance.clockIn')}
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
