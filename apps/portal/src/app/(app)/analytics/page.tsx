'use client';

import { BarChart3, CalendarCheck, RefreshCw, TrendingDown, UserMinus, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { getAnalyticsDashboard, runAnalyticsRollup } from '../../../lib/api/analytics';
import { listBranches } from '../../../lib/api/tenancy';
import { formatDate, formatNumber, formatPercent } from '../../../lib/format';
import type { AnalyticsDashboard } from '../../../lib/api/types';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Input, Label, Select } from '../../../components/ui/Field';
import { SegmentedControl } from '../../../components/ui/SegmentedControl';
import { BarBreakdown, ChartCard, DonutChart, KpiCard, TrendAreaChart, topN, type Trend } from '../../../components/charts';

type RangeKey = '7d' | '30d' | '90d' | 'custom';
const RANGE_DAYS: Record<Exclude<RangeKey, 'custom'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

const DAY_MS = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
/** "Yesterday" — the last fully-rolled-up day, the same default the API applies. */
function yesterday(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
function shift(iso: string, days: number): string {
  return isoDate(new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS));
}
function spanDays(from: string, to: string): number {
  return Math.max(1, Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS));
}

/** Relative change as a trend pill. `goodWhen` says which direction is good for this KPI. */
function relativeTrend(cur: number, prev: number | null, goodWhen: 'up' | 'down', locale: string, title: string): Trend | null {
  if (prev === null || prev === 0) return null;
  const change = (cur - prev) / prev;
  const dir = Math.abs(change) < 0.0005 ? 'flat' : change > 0 ? 'up' : 'down';
  const sign = change > 0 ? '+' : '';
  return {
    text: `${sign}${new Intl.NumberFormat(locale.replace('_', '-'), { style: 'percent', maximumFractionDigits: 1 }).format(change)}`,
    dir,
    tone: dir === 'flat' ? 'neutral' : (dir === 'up') === (goodWhen === 'up') ? 'good' : 'bad',
    title,
  };
}
/** Percentage-point change for a ratio KPI (rates are already percentages — a relative % of a % misleads). */
function pointTrend(cur: number, prev: number | null, goodWhen: 'up' | 'down', locale: string, title: string): Trend | null {
  if (prev === null) return null;
  const pp = (cur - prev) * 100;
  const dir = Math.abs(pp) < 0.05 ? 'flat' : pp > 0 ? 'up' : 'down';
  return {
    text: `${pp > 0 ? '+' : ''}${new Intl.NumberFormat(locale.replace('_', '-'), { maximumFractionDigits: 1 }).format(pp)} pp`,
    dir,
    tone: dir === 'flat' ? 'neutral' : (dir === 'up') === (goodWhen === 'up') ? 'good' : 'bad',
    title,
  };
}

const hasAnyData = (d: AnalyticsDashboard | null) =>
  !!d &&
  (d.headcount.total > 0 || d.movement.joiners > 0 || d.movement.leavers > 0 || d.attendance.employeeDays > 0 || d.leave.byType.length > 0);

export default function AnalyticsPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const canView = can(PERMISSIONS.ANALYTICS_READ);

  const [branchId, setBranchId] = useState('');
  const [range, setRange] = useState<RangeKey>('30d');
  const [customFrom, setCustomFrom] = useState(() => shift(isoDate(yesterday()), -30));
  const [customTo, setCustomTo] = useState(() => isoDate(yesterday()));
  const [rollupMsg, setRollupMsg] = useState<string | null>(null);
  const [rollupBusy, setRollupBusy] = useState(false);

  const to = range === 'custom' ? customTo : isoDate(yesterday());
  const from = range === 'custom' ? customFrom : shift(to, -RANGE_DAYS[range]);
  const rangeInvalid = from > to;
  const span = spanDays(from, to);
  const prevTo = shift(from, -1);
  const prevFrom = shift(prevTo, -span);

  const { data: branches } = useAsync(() => (canView ? listBranches() : Promise.resolve([])), [canView]);
  const { data: dashboard, loading, error, reload } = useAsync(
    () => (canView && !rangeInvalid ? getAnalyticsDashboard({ branchId: branchId || undefined, from, to }) : Promise.resolve(null)),
    [canView, branchId, from, to],
  );
  // The comparison period is a second read of the SAME precomputed-rollup endpoint (cheap) — never a live aggregate.
  const { data: previous } = useAsync(
    () => (canView && !rangeInvalid ? getAnalyticsDashboard({ branchId: branchId || undefined, from: prevFrom, to: prevTo }).catch(() => null) : Promise.resolve(null)),
    [canView, branchId, prevFrom, prevTo],
  );

  const branchName = (id: string) => branches?.find((b) => b.id === id)?.name ?? id.slice(0, 8);
  const hasData = hasAnyData(dashboard);
  const prev = hasAnyData(previous) ? previous : null;
  const vs = t('analytics.kpi.vsPrevious');

  const view = useMemo(() => {
    if (!dashboard) return null;
    const a = dashboard.attendance;
    const trend = a.trend.map((r) => ({ ...r, label: formatDate(r.date, locale) }));
    const spark = a.trend.map((r) => (r.employeeCount > 0 ? r.presentCount / r.employeeCount : 0));
    const mix = [
      { name: t('analytics.attendance.present'), value: a.presentCount },
      { name: t('analytics.attendance.late'), value: a.lateCount },
      { name: t('analytics.attendance.absent'), value: a.absentCount },
      { name: t('analytics.attendance.onLeave'), value: a.onLeaveCount },
      { name: t('analytics.chart.weekend'), value: a.weekendCount },
      { name: t('analytics.chart.holiday'), value: a.holidayCount },
    ];
    const byBranch = dashboard.headcount.byBranch.map((r) => ({ label: branchName(r.branchId), count: r.count }));
    const movement = dashboard.movement.byBranch.map((r) => ({ label: branchName(r.branchId), joiners: r.joiners, leavers: r.leavers }));
    const employment = topN(
      dashboard.headcount.byEmploymentType.map((r) => ({ name: t(`analytics.employmentType.${r.employmentType}`), value: r.count })),
      6,
      t('common.other'),
    );
    const gender = topN(
      dashboard.headcount.byGender.map((r) => ({ name: r.gender ? t(`analytics.gender.${r.gender}`) : t('analytics.gender.unspecified'), value: r.count })),
      6,
      t('common.other'),
    );
    const leave = dashboard.leave.byType.map((r) => ({ label: t(`leave.type.${r.leaveType}`), entitled: r.entitledDays, used: r.usedToDate }));
    return { trend, spark, mix, byBranch, movement, employment, gender, leave };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, branches, locale]);

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  async function runRollup() {
    setRollupBusy(true);
    setRollupMsg(null);
    try {
      await runAnalyticsRollup();
      setRollupMsg(t('analytics.empty.queued'));
    } catch (e) {
      setRollupMsg(e instanceof Error ? e.message : t('error.generic'));
    } finally {
      setRollupBusy(false);
    }
  }

  const showSkeleton = loading && !dashboard;
  const d = dashboard;
  const num = (n: number) => formatNumber(n, locale);

  return (
    <div className="max-w-[88rem] space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">{t('analytics.title')}</h1>
          <p className="page-subtitle">
            {formatDate(from, locale)} – {formatDate(to, locale)}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-52">
            <Label htmlFor="analytics-branch">{t('analytics.filters.branch')}</Label>
            <Select id="analytics-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t('analytics.filters.allBranches')}</option>
              {(branches ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink-700">{t('analytics.range.label')}</span>
            <SegmentedControl
              label={t('analytics.range.label')}
              value={range}
              onChange={setRange}
              options={[
                { value: '7d', label: t('analytics.range.7d'), testId: 'range-7d' },
                { value: '30d', label: t('analytics.range.30d'), testId: 'range-30d' },
                { value: '90d', label: t('analytics.range.90d'), testId: 'range-90d' },
                { value: 'custom', label: t('analytics.range.custom'), testId: 'range-custom' },
              ]}
            />
          </div>
          {range === 'custom' && (
            <>
              <div>
                <Label htmlFor="analytics-from">{t('common.from')}</Label>
                <Input id="analytics-from" type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="analytics-to">{t('common.to')}</Label>
                <Input id="analytics-to" type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
              </div>
            </>
          )}
          <Button variant="secondary" size="sm" onClick={reload} aria-label={t('common.refresh')} title={t('common.refresh')}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          </Button>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {rangeInvalid && <Alert tone="error">{t('analytics.range.invalid')}</Alert>}

      {!showSkeleton && d && !hasData && (
        <Card>
          <CardBody>
            <EmptyState icon={BarChart3} title={t('analytics.empty.title')} description={t('analytics.empty.body')} />
            <div className="flex flex-col items-center gap-2 pb-4">
              <Button variant="secondary" size="sm" onClick={runRollup} loading={rollupBusy}>
                {t('analytics.empty.run')}
              </Button>
              {rollupMsg && <p className="text-xs text-ink-500">{rollupMsg}</p>}
            </div>
          </CardBody>
        </Card>
      )}

      {(showSkeleton || (d && hasData)) && (
        <div className={`space-y-6 transition-opacity duration-200 ${loading && !showSkeleton ? 'opacity-60' : 'opacity-100'}`}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
            <KpiCard
              index={0}
              loading={showSkeleton}
              icon={Users}
              testId="kpi-headcount-total"
              label={t('analytics.headcount.total')}
              value={d ? num(d.headcount.total) : ''}
              hint={d?.headcount.asOfDate ? t('analytics.headcount.asOf', { date: formatDate(d.headcount.asOfDate, locale) }) : undefined}
              trend={d && prev ? relativeTrend(d.headcount.total, prev.headcount.total, 'up', locale, vs) : null}
            />
            <KpiCard
              index={1}
              loading={showSkeleton}
              icon={UserPlus}
              testId="kpi-joiners"
              label={t('analytics.movement.joiners')}
              value={d ? num(d.movement.joiners) : ''}
              trend={d && prev ? relativeTrend(d.movement.joiners, prev.movement.joiners, 'up', locale, vs) : null}
            />
            <KpiCard
              index={2}
              loading={showSkeleton}
              icon={UserMinus}
              testId="kpi-leavers"
              label={t('analytics.movement.leavers')}
              value={d ? num(d.movement.leavers) : ''}
              trend={d && prev ? relativeTrend(d.movement.leavers, prev.movement.leavers, 'down', locale, vs) : null}
            />
            <KpiCard
              index={3}
              loading={showSkeleton}
              icon={TrendingDown}
              testId="kpi-attrition"
              label={t('analytics.movement.attritionRate')}
              value={d ? formatPercent(d.movement.attritionRate, locale) : ''}
              trend={d && prev ? pointTrend(d.movement.attritionRate, prev.movement.attritionRate, 'down', locale, vs) : null}
            />
            <KpiCard
              index={4}
              loading={showSkeleton}
              icon={CalendarCheck}
              testId="kpi-attendance-rate"
              label={t('analytics.attendance.rate')}
              value={d ? formatPercent(d.attendance.attendanceRate, locale) : ''}
              trend={d && prev ? pointTrend(d.attendance.attendanceRate, prev.attendance.attendanceRate, 'up', locale, vs) : null}
              spark={view?.spark}
            />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <ChartCard
              className="xl:col-span-2"
              testId="chart-attendance-trend"
              title={t('analytics.chart.attendanceTrend')}
              subtitle={t('analytics.range.last', { days: span })}
              loading={showSkeleton}
              empty={!!d && d.attendance.trend.length === 0}
            >
              {view && (
                <TrendAreaChart
                  data={view.trend}
                  xKey="label"
                  series={[
                    { key: 'presentCount', label: t('analytics.attendance.present'), color: 0 },
                    { key: 'lateCount', label: t('analytics.attendance.late'), color: 2 },
                    { key: 'absentCount', label: t('analytics.attendance.absent'), color: 4 },
                  ]}
                />
              )}
            </ChartCard>
            <ChartCard
              testId="chart-attendance-mix"
              title={t('analytics.chart.attendanceMix')}
              loading={showSkeleton}
              empty={!!d && d.attendance.employeeDays === 0}
            >
              {view && d && <DonutChart data={view.mix} centerLabel={t('analytics.chart.total')} />}
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard
              testId="chart-headcount-branch"
              title={t('analytics.chart.headcountByBranch')}
              loading={showSkeleton}
              empty={!!d && d.headcount.byBranch.length === 0}
            >
              {view && <BarBreakdown data={view.byBranch} xKey="label" series={[{ key: 'count', label: t('analytics.headcount.total'), color: 0 }]} />}
            </ChartCard>
            <ChartCard
              testId="chart-movement"
              title={t('analytics.chart.movement')}
              loading={showSkeleton}
              empty={!!d && d.movement.byBranch.length === 0}
            >
              {view && (
                <BarBreakdown
                  data={view.movement}
                  xKey="label"
                  series={[
                    { key: 'joiners', label: t('analytics.movement.joiners'), color: 0 },
                    { key: 'leavers', label: t('analytics.movement.leavers'), color: 4 },
                  ]}
                />
              )}
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard testId="chart-employment" title={t('analytics.chart.employmentMix')} loading={showSkeleton} empty={!!view && view.employment.length === 0} height={220}>
              {view && <DonutChart data={view.employment} centerLabel={t('analytics.chart.total')} />}
            </ChartCard>
            <ChartCard testId="chart-gender" title={t('analytics.chart.genderMix')} loading={showSkeleton} empty={!!view && view.gender.length === 0} height={220}>
              {view && <DonutChart data={view.gender} centerLabel={t('analytics.chart.total')} />}
            </ChartCard>
          </div>

          <ChartCard
            testId="chart-leave"
            title={t('analytics.chart.leaveUtilization')}
            loading={showSkeleton}
            empty={!!d && d.leave.byType.length === 0}
            height={220}
          >
            {view && d && (
              <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
                <BarBreakdown
                  horizontal
                  height={220}
                  data={view.leave}
                  xKey="label"
                  series={[
                    { key: 'entitled', label: t('analytics.chart.entitled'), color: 1 },
                    { key: 'used', label: t('analytics.chart.used'), color: 0 },
                  ]}
                />
                <div className="overflow-x-auto">
                  <table className="w-full text-start text-sm">
                    <thead>
                      <tr className="border-b border-ink-100">
                        <th className="py-2 text-start">{t('common.type')}</th>
                        <th className="py-2 text-start">{t('analytics.leave.entitled')}</th>
                        <th className="py-2 text-start">{t('analytics.leave.usedToDate')}</th>
                        <th className="py-2 text-start">{t('analytics.leave.usedInPeriod')}</th>
                        <th className="py-2 text-start">{t('analytics.leave.utilization')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {d.leave.byType.map((row) => (
                        <tr key={row.leaveType}>
                          <td className="py-2.5 text-ink-800">{t(`leave.type.${row.leaveType}`)}</td>
                          <td className="py-2.5 text-ink-600">{num(row.entitledDays)}</td>
                          <td className="py-2.5 text-ink-600">{num(row.usedToDate)}</td>
                          <td className="py-2.5 text-ink-600">{num(row.usedInPeriod)}</td>
                          <td className="py-2.5">
                            <span className="inline-flex items-center gap-2">
                              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-sand-200">
                                <span className="block h-full rounded-full bg-chart-1" style={{ width: `${Math.min(100, row.utilizationRate * 100)}%` }} />
                              </span>
                              <span className="text-ink-600">{formatPercent(row.utilizationRate, locale)}</span>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </ChartCard>
        </div>
      )}
    </div>
  );
}
