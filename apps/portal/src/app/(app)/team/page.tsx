'use client';

import { useState } from 'react';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { getAttendanceSummaryReport } from '../../../lib/api/attendance';
import { getLeaveCalendar } from '../../../lib/api/leave';
import { formatDate } from '../../../lib/format';
import { PERMISSIONS } from '@hrm/shared';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Input, Label } from '../../../components/ui/Field';
import { StatusBadge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';

function startOfMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function endOfMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

export default function TeamPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [from, setFrom] = useState(startOfMonth());
  const [to, setTo] = useState(endOfMonth());

  const canAttendance = can(PERMISSIONS.ATTENDANCE_APPROVE);
  const canLeave = can(PERMISSIONS.LEAVE_APPROVE);

  const { data: summary, loading: summaryLoading } = useAsync(
    () => (canAttendance ? getAttendanceSummaryReport({ from, to }) : Promise.resolve([])),
    [from, to, canAttendance],
  );
  const { data: calendar, loading: calendarLoading } = useAsync(
    () => (canLeave ? getLeaveCalendar({ from, to }) : Promise.resolve([])),
    [from, to, canLeave],
  );

  if (!canAttendance && !canLeave) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('nav.team')}</h1>

      <div className="flex items-end gap-4">
        <div>
          <Label htmlFor="from">{t('common.from')}</Label>
          <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="to">{t('common.to')}</Label>
          <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {canAttendance && (
        <Card>
          <CardHeader>
            <CardTitle>{t('attendance.teamReport')}</CardTitle>
          </CardHeader>
          <CardBody>
            {summaryLoading ? (
              <PageSpinner />
            ) : !summary || summary.length === 0 ? (
              <EmptyState title={t('attendance.noRecords')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                      <th className="py-2 text-start font-medium">{t('common.employee')}</th>
                      <th className="py-2 text-start font-medium">{t('common.date')}</th>
                      <th className="py-2 text-start font-medium">{t('common.status')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {summary.map((s) => (
                      <tr key={s.id}>
                        <td className="py-2.5 text-ink-800">{s.employeeId}</td>
                        <td className="py-2.5 text-ink-600">{formatDate(s.workDate, locale)}</td>
                        <td className="py-2.5">
                          <StatusBadge status={s.status} label={t(`attendance.summary.${s.status}`)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {canLeave && (
        <Card>
          <CardHeader>
            <CardTitle>{t('leave.teamCalendar')}</CardTitle>
          </CardHeader>
          <CardBody>
            {calendarLoading ? (
              <PageSpinner />
            ) : !calendar || calendar.length === 0 ? (
              <EmptyState title={t('leave.noEntries')} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {calendar.map((entry, i) => (
                  <li key={i} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="text-ink-800">{entry.employeeName}</span>
                    <span className="text-ink-600">
                      {t(`leave.type.${entry.leaveType}`)} · {formatDate(entry.startDate, locale)} – {formatDate(entry.endDate, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
