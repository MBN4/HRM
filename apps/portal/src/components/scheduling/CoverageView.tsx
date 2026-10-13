'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { getCoverage, type Coverage } from '../../lib/api/scheduling';
import { ymdInTimeZone } from '../../lib/attendance-status';
import { formatDayLong, formatDayShort, windowFor } from '../../lib/scheduling';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { PageSpinner } from '../ui/Spinner';
import { useScheduling } from './SchedulingContext';
import { ShiftChip } from './ShiftChip';
import { WindowToolbar } from './WindowToolbar';

/**
 * Per-day, per-shift coverage: headcount vs the shift's min-staffing target, with gaps flagged by colour AND an icon
 * AND text. Counts for default-hours / day-off / on-leave come straight from `GET /scheduling/coverage`; nothing is
 * recomputed here. Pick a cell to list the people.
 */
export function CoverageView() {
  const { t, locale } = useI18n();
  const { anchor, mode, departmentId } = useScheduling();
  const { from, to } = windowFor(anchor, mode);
  const [data, setData] = useState<Coverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ date: string; shiftId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPicked(null);
    getCoverage(from, to, departmentId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
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
  }, [from, to, departmentId]);

  const today = useMemo(() => ymdInTimeZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  const shiftOf = useMemo(() => new Map((data?.shifts ?? []).map((s) => [s.id, s])), [data]);
  const pickedDay = picked && data?.days.find((d) => d.date === picked.date);
  const pickedCell = pickedDay?.shifts.find((s) => s.shiftId === picked?.shiftId);
  const rowShifts = (data?.shifts ?? []).filter((s) => data?.days.some((d) => d.shifts.some((x) => x.shiftId === s.id)));

  return (
    <div className="space-y-4">
      <WindowToolbar />
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data ? (
        <PageSpinner />
      ) : data ? (
        <>
          {data.gaps.length > 0 ? (
            <Alert tone="error" data-testid="coverage-gaps-summary">
              {t('scheduling.coverage.gapsSummary', { count: data.gaps.length })}
            </Alert>
          ) : (
            <Alert tone="success" data-testid="coverage-ok">
              {t('scheduling.coverage.noGaps')}
            </Alert>
          )}

          {rowShifts.length === 0 && data.days.every((d) => d.defaultHours + d.off + d.onLeave === 0) ? (
            <EmptyState title={t('scheduling.coverage.empty')} description={t('scheduling.coverage.emptyHint')} />
          ) : (
            <div className={`overflow-x-auto rounded-xl border border-ink-100 bg-surface ${loading ? 'opacity-60' : ''}`} data-testid="coverage-table-wrap">
              <table className="w-full min-w-max text-sm" data-testid="coverage-table">
                <caption className="sr-only">{t('scheduling.coverage.caption')}</caption>
                <thead>
                  <tr className="border-b border-ink-100">
                    <th scope="col" className="sticky start-0 z-10 border-e border-ink-100 bg-surface-raised px-3 py-2 text-start text-xs font-medium text-ink-500">
                      {t('scheduling.coverage.row')}
                    </th>
                    {data.days.map((d) => (
                      <th key={d.date} scope="col" className={`px-2 py-2 text-center text-xs font-semibold ${d.date === today ? 'bg-brand-50 text-brand-700' : 'text-ink-600'}`}>
                        <span className="block">{formatDayShort(d.date, locale)}</span>
                        {!d.workingDay && <span className="block text-[0.65rem] font-normal text-ink-400">{t('scheduling.coverage.nonWorking')}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rowShifts.map((s) => (
                    <tr key={s.id} className="border-b border-ink-100" data-testid={`coverage-row-${s.id}`}>
                      <th scope="row" className="sticky start-0 z-10 border-e border-ink-100 bg-surface px-3 py-2 text-start font-normal">
                        <ShiftChip name={s.name} color={s.color} startTime={s.startTime} endTime={s.endTime} />
                        {s.minStaffing != null && <span className="ms-1 text-[0.7rem] text-ink-500">{t('scheduling.coverage.target', { count: s.minStaffing })}</span>}
                      </th>
                      {data.days.map((d) => {
                        const cell = d.shifts.find((x) => x.shiftId === s.id);
                        if (!cell) return <td key={d.date} className="px-2 py-2 text-center text-ink-300">—</td>;
                        const gap = cell.gap;
                        const isPicked = picked?.date === d.date && picked.shiftId === s.id;
                        return (
                          <td key={d.date} className={`p-1 text-center ${!d.workingDay ? 'bg-sand-100/60' : ''}`}>
                            <button
                              type="button"
                              data-testid={`coverage-cell-${s.id}-${d.date}`}
                              data-gap={gap ? 'true' : 'false'}
                              data-count={cell.count}
                              aria-pressed={isPicked}
                              aria-label={`${s.name}, ${formatDayLong(d.date, locale)}: ${t('scheduling.coverage.headcount', { count: cell.count })}${
                                cell.minStaffing != null ? `, ${t('scheduling.coverage.target', { count: cell.minStaffing })}` : ''
                              }${gap ? `, ${t('scheduling.coverage.gap')}` : ''}`}
                              onClick={() => setPicked(isPicked ? null : { date: d.date, shiftId: s.id })}
                              className={`flex w-full min-w-[4.5rem] flex-col items-center rounded-lg border px-2 py-1.5 text-xs font-semibold tabular-nums ${
                                gap ? 'border-coral-200 bg-coral-50 text-coral-700' : 'border-ink-100 bg-surface text-ink-800 hover:bg-sand-100'
                              } ${isPicked ? 'ring-2 ring-accent-500' : ''}`}
                            >
                              <span className="flex items-center gap-1">
                                {gap ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : cell.minStaffing != null ? <CheckCircle2 className="h-3.5 w-3.5 text-brand-600" aria-hidden /> : null}
                                {cell.minStaffing != null ? `${cell.count} / ${cell.minStaffing}` : cell.count}
                              </span>
                              {gap && <span className="text-[0.65rem] font-semibold">{t('scheduling.coverage.short', { count: (cell.minStaffing ?? 0) - cell.count })}</span>}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {([['defaultHours', 'scheduling.coverage.defaultHours'], ['off', 'scheduling.coverage.off'], ['onLeave', 'scheduling.coverage.onLeave']] as const).map(([k, label]) => (
                    <tr key={k} className="border-b border-ink-100 last:border-0">
                      <th scope="row" className="sticky start-0 z-10 border-e border-ink-100 bg-surface px-3 py-2 text-start text-xs font-medium text-ink-600">
                        {t(label)}
                      </th>
                      {data.days.map((d) => (
                        <td key={d.date} className="px-2 py-2 text-center text-xs tabular-nums text-ink-600" data-testid={`coverage-${k}-${d.date}`}>
                          {d[k]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pickedCell && pickedDay && (
            <Card data-testid="coverage-detail">
              <CardHeader>
                <CardTitle>
                  {shiftOf.get(pickedCell.shiftId)?.name} · {formatDayLong(pickedDay.date, locale)}
                </CardTitle>
                {pickedCell.gap && (
                  <Badge tone="danger">
                    <AlertTriangle className="me-1 h-3 w-3" aria-hidden />
                    {t('scheduling.coverage.gap')}
                  </Badge>
                )}
              </CardHeader>
              <CardBody>
                {pickedCell.people.length === 0 ? (
                  <p className="text-sm text-ink-500">{t('scheduling.coverage.nobody')}</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {pickedCell.people.map((p) => (
                      <li key={p.employeeId} className="flex items-center gap-1.5 rounded-lg border border-ink-100 px-2.5 py-1 text-sm">
                        {p.name}
                        <span className="text-xs text-ink-500">· {t(`scheduling.via.${p.via}`)}</span>
                        {p.status === 'DRAFT' && <Badge tone="warning">{t('scheduling.status.DRAFT')}</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}

