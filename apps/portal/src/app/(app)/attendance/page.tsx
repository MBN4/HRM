'use client';

import { useState } from 'react';
import { Wrench } from 'lucide-react';
import { useI18n } from '../../../i18n/I18nProvider';
import { useSession } from '../../../lib/session/SessionProvider';
import { useAsync } from '../../../lib/useAsync';
import { listAttendanceRecords, listRegularizations } from '../../../lib/api/attendance';
import { formatDate, formatMinutesAsHours, formatTime } from '../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { StatusBadge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { ClockWidget } from '../../../components/attendance/ClockWidget';
import { RegularizeForm } from '../../../components/attendance/RegularizeForm';

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function AttendancePage() {
  const { t, locale } = useI18n();
  const { employee, employeeLoading } = useSession();
  const [regularizing, setRegularizing] = useState(false);

  const { data: records, loading: recordsLoading, reload: reloadRecords } = useAsync(
    () => (employee ? listAttendanceRecords({ employeeId: employee.id, from: dateOffset(-30), to: dateOffset(1) }) : Promise.resolve([])),
    [employee?.id],
  );
  const { data: regularizations, reload: reloadRegularizations } = useAsync(
    () => (employee ? listRegularizations({ employeeId: employee.id }) : Promise.resolve([])),
    [employee?.id],
  );

  if (employeeLoading) return <PageSpinner />;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('attendance.title')}</h1>
        {employee && (
          <Button variant="secondary" onClick={() => setRegularizing(true)}>
            <Wrench className="h-4 w-4" aria-hidden />
            {t('attendance.regularize')}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('attendance.today')}</CardTitle>
        </CardHeader>
        <CardBody>
          <ClockWidget locale={locale} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('attendance.history')}</CardTitle>
        </CardHeader>
        <CardBody>
          {recordsLoading ? (
            <PageSpinner />
          ) : !records || records.length === 0 ? (
            <EmptyState title={t('attendance.noRecords')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('common.date')}</th>
                    <th className="py-2 text-start font-medium">{t('attendance.clockIn')}</th>
                    <th className="py-2 text-start font-medium">{t('attendance.clockOut')}</th>
                    <th className="py-2 text-start font-medium">{t('attendance.worked')}</th>
                    <th className="py-2 text-start font-medium">{t('attendance.overtime')}</th>
                    <th className="py-2 text-start font-medium">{t('attendance.late')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {records
                    .slice()
                    .sort((a, b) => b.workDate.localeCompare(a.workDate))
                    .map((r) => (
                      <tr key={r.id}>
                        <td className="py-2.5 text-ink-800">{formatDate(r.workDate, locale)}</td>
                        <td className="py-2.5 text-ink-600">{formatTime(r.clockInAt, locale)}</td>
                        <td className="py-2.5 text-ink-600">{formatTime(r.clockOutAt, locale)}</td>
                        <td className="py-2.5 text-ink-600">{formatMinutesAsHours(r.workedMinutes)}</td>
                        <td className="py-2.5 text-ink-600">{formatMinutesAsHours(r.overtimeMinutes)}</td>
                        <td className="py-2.5 text-ink-600">{formatMinutesAsHours(r.lateMinutes)}</td>
                        <td className="py-2.5">
                          <StatusBadge status={r.status} label={t(`attendance.status.${r.status}`)} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {regularizations && regularizations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('attendance.regularize')}</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="divide-y divide-ink-100">
              {regularizations.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <p className="text-ink-800">{formatDate(r.workDate, locale)}</p>
                    <p className="text-xs text-ink-400">{r.reason}</p>
                  </div>
                  <StatusBadge status={r.status} label={t(`leave.status.${r.status}`)} />
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {regularizing && (
        <Modal title={t('attendance.regularizeTitle')} onClose={() => setRegularizing(false)}>
          <RegularizeForm
            onCancel={() => setRegularizing(false)}
            onSubmitted={() => {
              setRegularizing(false);
              reloadRecords();
              reloadRegularizations();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
