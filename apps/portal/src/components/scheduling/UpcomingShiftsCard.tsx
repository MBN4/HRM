'use client';

import Link from 'next/link';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { getMySchedule } from '../../lib/api/scheduling';
import { formatDayShort } from '../../lib/scheduling';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { ShiftChip, ShiftTimes } from './ShiftChip';

const MAX_ROWS = 5;

/** Dashboard card: the next few WORKING shifts (rostered or standing) from `GET /scheduling/my-schedule`. Renders nothing without an employee profile. */
export function UpcomingShiftsCard() {
  const { t, locale } = useI18n();
  const { data, loading, error } = useAsync(() => getMySchedule(), []);
  if (error) return null;
  const upcoming = (data?.days ?? []).filter((d) => d.kind === 'SHIFT' && d.shift && d.date >= data!.today).slice(0, MAX_ROWS);

  return (
    <Card data-testid="upcoming-shifts-card">
      <CardHeader>
        <CardTitle>{t('schedule.upcomingCard')}</CardTitle>
        <Link href="/schedule" className="text-xs font-semibold text-brand-700 hover:underline">
          {t('common.viewAll')}
        </Link>
      </CardHeader>
      <CardBody>
        {loading && !data ? (
          <p className="text-sm text-ink-400">{t('common.loading')}</p>
        ) : upcoming.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="upcoming-shifts-empty">{t('schedule.upcomingEmpty')}</p>
        ) : (
          <ul className="space-y-2.5">
            {upcoming.map((d) => (
              <li key={d.date} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid={`upcoming-shift-${d.date}`}>
                <span className="font-medium text-ink-800">{formatDayShort(d.date, locale)}</span>
                <span className="flex items-center gap-2">
                  <ShiftChip name={d.shift!.name} color={d.shift!.color} />
                  <ShiftTimes startTime={d.shift!.startTime} endTime={d.shift!.endTime} className="text-xs text-ink-600" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
