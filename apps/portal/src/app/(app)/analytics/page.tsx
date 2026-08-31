'use client';

import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { getAnalyticsDashboard } from '../../../lib/api/analytics';
import { listBranches } from '../../../lib/api/tenancy';
import { formatDate, formatNumber, formatPercent } from '../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Label, Select } from '../../../components/ui/Field';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';

const RANGE_DAYS = 30;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function defaultTo(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1); // "yesterday" — the last fully-rolled-up day, same default the API applies.
  return isoDate(d);
}
function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1 - RANGE_DAYS);
  return isoDate(d);
}

function KpiTile({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <Card>
      <CardBody>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</p>
        <p data-testid={testId} className="mt-1 text-2xl font-semibold text-ink-900">
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
      </CardBody>
    </Card>
  );
}

export default function AnalyticsPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(defaultTo());

  const canView = can(PERMISSIONS.ANALYTICS_READ);

  const { data: branches } = useAsync(() => (canView ? listBranches() : Promise.resolve([])), [canView]);
  const { data: dashboard, loading, error } = useAsync(
    () => (canView ? getAnalyticsDashboard({ branchId: branchId || undefined, from, to }) : Promise.resolve(null)),
    [canView, branchId, from, to],
  );

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  const hasData =
    dashboard &&
    (dashboard.headcount.total > 0 ||
      dashboard.movement.joiners > 0 ||
      dashboard.movement.leavers > 0 ||
      dashboard.attendance.employeeDays > 0 ||
      dashboard.leave.byType.length > 0);

  return (
    <div className="max-w-6xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('analytics.title')}</h1>

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-56">
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
          <Label htmlFor="analytics-from">{t('common.from')}</Label>
          <input
            id="analytics-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900"
          />
        </div>
        <div>
          <Label htmlFor="analytics-to">{t('common.to')}</Label>
          <input
            id="analytics-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900"
          />
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {loading && <PageSpinner />}

      {!loading && dashboard && !hasData && <EmptyState title={t('analytics.noData')} />}

      {!loading && dashboard && hasData && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <KpiTile
              testId="kpi-headcount-total"
              label={t('analytics.headcount.total')}
              value={formatNumber(dashboard.headcount.total, locale)}
              hint={dashboard.headcount.asOfDate ? t('analytics.headcount.asOf', { date: formatDate(dashboard.headcount.asOfDate, locale) }) : undefined}
            />
            <KpiTile testId="kpi-joiners" label={t('analytics.movement.joiners')} value={formatNumber(dashboard.movement.joiners, locale)} />
            <KpiTile testId="kpi-leavers" label={t('analytics.movement.leavers')} value={formatNumber(dashboard.movement.leavers, locale)} />
            <KpiTile testId="kpi-attrition" label={t('analytics.movement.attritionRate')} value={formatPercent(dashboard.movement.attritionRate, locale)} />
            <KpiTile testId="kpi-attendance-rate" label={t('analytics.attendance.rate')} value={formatPercent(dashboard.attendance.attendanceRate, locale)} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t('analytics.headcount.byBranch')}</CardTitle>
              </CardHeader>
              <CardBody>
                {dashboard.headcount.byBranch.length === 0 ? (
                  <p className="text-sm text-ink-400">{t('common.noData')}</p>
                ) : (
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dashboard.headcount.byBranch.map((r) => ({ ...r, label: branchName(branches, r.branchId) }))}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                        <Tooltip formatter={(value) => formatNumber(Number(value), locale)} />
                        <Bar dataKey="count" fill="#0d9488" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('analytics.attendance.trend')}</CardTitle>
              </CardHeader>
              <CardBody>
                {dashboard.attendance.trend.length === 0 ? (
                  <p className="text-sm text-ink-400">{t('common.noData')}</p>
                ) : (
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dashboard.attendance.trend.map((r) => ({ ...r, label: formatDate(r.date, locale) }))}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                        <Tooltip formatter={(value) => formatNumber(Number(value), locale)} />
                        <Line type="monotone" dataKey="presentCount" name={t('analytics.attendance.present')} stroke="#0d9488" dot={false} />
                        <Line type="monotone" dataKey="absentCount" name={t('analytics.attendance.absent')} stroke="#e11d48" dot={false} />
                        <Line type="monotone" dataKey="lateCount" name={t('analytics.attendance.late')} stroke="#d97706" dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardBody>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t('analytics.headcount.byEmploymentType')}</CardTitle>
              </CardHeader>
              <CardBody>
                <BreakdownList
                  rows={dashboard.headcount.byEmploymentType.map((r) => ({
                    label: t(`analytics.employmentType.${r.employmentType}`),
                    count: r.count,
                  }))}
                  locale={locale}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('analytics.headcount.byGender')}</CardTitle>
              </CardHeader>
              <CardBody>
                <BreakdownList
                  rows={dashboard.headcount.byGender.map((r) => ({
                    label: r.gender ? t(`analytics.gender.${r.gender}`) : t('analytics.gender.unspecified'),
                    count: r.count,
                  }))}
                  locale={locale}
                />
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t('analytics.leave.title')}</CardTitle>
            </CardHeader>
            <CardBody>
              {dashboard.leave.byType.length === 0 ? (
                <p className="text-sm text-ink-400">{t('common.noData')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-start text-sm">
                    <thead>
                      <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                        <th className="py-2 text-start font-medium">{t('common.type')}</th>
                        <th className="py-2 text-start font-medium">{t('analytics.leave.entitled')}</th>
                        <th className="py-2 text-start font-medium">{t('analytics.leave.usedToDate')}</th>
                        <th className="py-2 text-start font-medium">{t('analytics.leave.usedInPeriod')}</th>
                        <th className="py-2 text-start font-medium">{t('analytics.leave.utilization')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {dashboard.leave.byType.map((row) => (
                        <tr key={row.leaveType}>
                          <td className="py-2.5 text-ink-800">{t(`leave.type.${row.leaveType}`)}</td>
                          <td className="py-2.5 text-ink-600">{formatNumber(row.entitledDays, locale)}</td>
                          <td className="py-2.5 text-ink-600">{formatNumber(row.usedToDate, locale)}</td>
                          <td className="py-2.5 text-ink-600">{formatNumber(row.usedInPeriod, locale)}</td>
                          <td className="py-2.5 text-ink-600">{formatPercent(row.utilizationRate, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function branchName(branches: { id: string; name: string }[] | null, branchId: string): string {
  return branches?.find((b) => b.id === branchId)?.name ?? branchId;
}

function BreakdownList({ rows, locale }: { rows: { label: string; count: number }[]; locale: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-400">—</p>;
  }
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.label} className="flex items-center justify-between text-sm">
          <span className="text-ink-600">{row.label}</span>
          <span className="font-semibold text-ink-900">{formatNumber(row.count, locale)}</span>
        </li>
      ))}
    </ul>
  );
}
