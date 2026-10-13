'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight, CalendarOff, Palmtree, Plane, Sun } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { getMySchedule, type MySchedule, type MyScheduleDay } from '../../lib/api/scheduling';
import { addDaysYmd } from '../../lib/attendance-status';
import { formatDayLong } from '../../lib/scheduling';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { PageSpinner } from '../ui/Spinner';
import { ShiftChip, ShiftTimes } from './ShiftChip';
import { SwapModal } from './SwapModal';
import { SwapRequests } from './SwapRequests';

/** One day of the schedule, as a labelled row. Shared by /schedule and the dashboard card (compact). */
export function ScheduleDayRow({ day, locale, onSwap, today }: { day: MyScheduleDay; locale: string; onSwap?: (d: MyScheduleDay) => void; today: string }) {
  const { t } = useI18n();
  const shift = day.shift;
  const overnight = shift ? shift.endTime <= shift.startTime : false;
  const canSwap = !!onSwap && day.kind === 'SHIFT' && day.date >= today && !day.swap;

  let main: React.ReactNode;
  if (day.kind === 'SHIFT' && shift) {
    main = (
      <div className="flex flex-wrap items-center gap-2">
        <ShiftChip name={shift.name} color={shift.color} />
        <ShiftTimes startTime={shift.startTime} endTime={shift.endTime} className="text-sm text-ink-700" />
        {day.via && <Badge tone={day.via === 'ROSTER' ? 'success' : 'neutral'}>{t(`schedule.via.${day.via}`)}</Badge>}
      </div>
    );
  } else if (day.kind === 'DEFAULT_HOURS') {
    main = (
      <span className="flex items-center gap-2 text-sm text-ink-700">
        <Sun className="h-4 w-4 text-ink-400" aria-hidden />
        {t('schedule.defaultHours', { start: day.startTime ?? '—', hours: day.requiredHours ?? 0 })}
      </span>
    );
  } else if (day.kind === 'DAY_OFF') {
    main = (
      <span className="flex items-center gap-2 text-sm text-ink-700">
        <CalendarOff className="h-4 w-4 text-ink-400" aria-hidden />
        {t('schedule.kind.DAY_OFF')}
      </span>
    );
  } else if (day.kind === 'LEAVE') {
    main = (
      <span className="flex items-center gap-2 text-sm text-sky-700">
        <Plane className="h-4 w-4" aria-hidden />
        {t('schedule.kind.LEAVE')}
      </span>
    );
  } else {
    main = (
      <span className="flex items-center gap-2 text-sm text-ink-500">
        <Palmtree className="h-4 w-4 text-ink-400" aria-hidden />
        {t(`schedule.kind.${day.kind}`)}
      </span>
    );
  }

  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3 ${day.date === today ? 'bg-brand-50/50' : ''}`}
      data-testid={`schedule-day-${day.date}`}
      data-kind={day.kind}
      data-via={day.via ?? ''}
      data-overnight={overnight ? 'true' : 'false'}
    >
      <div className="min-w-[11rem]">
        <p className="text-sm font-semibold text-ink-900">{formatDayLong(day.date, locale)}</p>
        {day.date === today && <p className="text-xs font-medium text-brand-700">{t('common.today')}</p>}
      </div>
      <div className="min-w-0 flex-1">{main}</div>
      <div className="flex items-center gap-2">
        {day.swap && (
          <Badge tone="warning">
            <span data-testid={`schedule-swap-${day.date}`}>{t(`schedule.swap.status.${day.swap.status}`)}</span>
          </Badge>
        )}
        {canSwap && (
          <Button size="sm" variant="secondary" onClick={() => onSwap?.(day)} data-testid={`schedule-swap-btn-${day.date}`} aria-label={`${t('schedule.swap.request')} — ${formatDayLong(day.date, locale)}`}>
            <ArrowLeftRight className="h-4 w-4" aria-hidden />
            {t('schedule.swap.request')}
          </Button>
        )}
      </div>
    </li>
  );
}

const DEFAULT_DAYS = 14;
const MAX_DAYS = 42;

/** `/schedule` — the signed-in employee's own upcoming days + shift swaps. */
export function MyScheduleView() {
  const { t, locale } = useI18n();
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [data, setData] = useState<MySchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [swapDay, setSwapDay] = useState<MyScheduleDay | null>(null);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Open-ended `from` = today in the BRANCH timezone (the API's default); `to` is derived from the response's own `today`.
    getMySchedule(undefined, undefined)
      .then(async (first) => {
        if (cancelled) return;
        if (days === DEFAULT_DAYS) return first;
        return getMySchedule(first.today, addDaysYmd(first.today, days - 1));
      })
      .then((res) => {
        if (cancelled || !res) return;
        setData(res);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : t('error.generic'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <div className="max-w-4xl space-y-6" data-testid="my-schedule-page">
      <div>
        <h1 className="page-title">{t('schedule.title')}</h1>
        <p className="page-subtitle">{t('schedule.subtitle')}</p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success" data-testid="schedule-notice">{notice}</Alert>}

      <Card>
        <CardHeader className="flex-wrap">
          <CardTitle>{t('schedule.upcoming')}</CardTitle>
          {data && <span className="text-xs text-ink-500">{t('schedule.timezone', { tz: data.timezone })}</span>}
        </CardHeader>
        <CardBody className="px-0 py-0">
          {loading && !data ? (
            <PageSpinner />
          ) : data ? (
            <ul className={`divide-y divide-ink-100 ${loading ? 'opacity-60' : ''}`} data-testid="schedule-list">
              {data.days.map((d) => (
                <ScheduleDayRow key={d.date} day={d} locale={locale} today={data.today} onSwap={setSwapDay} />
              ))}
            </ul>
          ) : null}
          {data && days < MAX_DAYS && (
            <div className="border-t border-ink-100 px-5 py-3">
              <Button variant="ghost" size="sm" onClick={() => setDays((d) => Math.min(MAX_DAYS, d + 14))} data-testid="schedule-more">
                {t('schedule.more')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {data && <SwapRequests myEmployeeId={data.employeeId} version={version} onChanged={reload} />}

      {swapDay && data && (
        <SwapModal
          day={swapDay}
          locale={locale}
          onClose={() => setSwapDay(null)}
          onSaved={() => {
            setSwapDay(null);
            setNotice(t('schedule.swap.sent'));
            reload();
          }}
        />
      )}
    </div>
  );
}
