'use client';

import Link from 'next/link';
import { Megaphone } from 'lucide-react';
import { useI18n } from '../../../i18n/I18nProvider';
import { useSession } from '../../../lib/session/SessionProvider';
import { useAsync } from '../../../lib/useAsync';
import { getLeaveBalances } from '../../../lib/api/leave';
import { getMyPendingApprovals } from '../../../lib/api/workflow';
import { listNotifications } from '../../../lib/api/notifications';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { ClockWidget } from '../../../components/attendance/ClockWidget';
import { EmptyState } from '../../../components/ui/EmptyState';
import { formatDateTime } from '../../../lib/format';

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const { employee, employeeLoading } = useSession();

  const { data: balances } = useAsync(() => (employee ? getLeaveBalances({ employeeId: employee.id }) : Promise.resolve([])), [employee?.id]);
  const { data: pendingApprovals } = useAsync(() => getMyPendingApprovals(), []);
  const { data: notifications } = useAsync(() => listNotifications(), []);

  return (
    <div className="space-y-6">
      <div>
        <h1 data-testid="dashboard-greeting" className="text-xl font-semibold text-ink-900">
          {t('dashboard.greeting', { name: employee ? employee.firstName : '' })}
        </h1>
      </div>

      {!employeeLoading && !employee && (
        <Card>
          <CardBody>
            <p className="text-sm text-ink-500">{t('dashboard.noEmployeeProfile')}</p>
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.clockWidget.title')}</CardTitle>
          </CardHeader>
          <CardBody>
            <ClockWidget locale={locale} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.leaveBalance.title')}</CardTitle>
            <Link href="/leave" className="text-xs font-medium text-brand-700 hover:underline">
              {t('common.viewAll')}
            </Link>
          </CardHeader>
          <CardBody>
            {!balances || balances.length === 0 ? (
              <p className="text-sm text-ink-400">{t('common.noData')}</p>
            ) : (
              <ul className="space-y-2">
                {balances.map((b) => (
                  <li key={b.leaveType} className="flex items-center justify-between text-sm">
                    <span className="text-ink-600">{t(`leave.type.${b.leaveType}`)}</span>
                    <span className="font-semibold text-ink-900">{b.availableDays}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.pendingApprovals.title')}</CardTitle>
            <Link href="/approvals" className="text-xs font-medium text-brand-700 hover:underline">
              {t('common.viewAll')}
            </Link>
          </CardHeader>
          <CardBody>
            <p className="text-3xl font-semibold text-ink-900">{pendingApprovals?.length ?? 0}</p>
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('dashboard.notifications.title')}</CardTitle>
            <Link href="/notifications" className="text-xs font-medium text-brand-700 hover:underline">
              {t('common.viewAll')}
            </Link>
          </CardHeader>
          <CardBody>
            {!notifications || notifications.length === 0 ? (
              <EmptyState title={t('notifications.empty')} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {notifications.slice(0, 5).map((n) => (
                  <li key={n.id} className="py-2.5 text-sm">
                    <p className="text-ink-800">{n.delivery.renderedSubject ?? n.eventType}</p>
                    <p className="text-xs text-ink-400">{formatDateTime(n.createdAt, locale)}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.announcements.title')}</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col items-center gap-2 py-8 text-center">
            <Megaphone className="h-6 w-6 text-ink-300" aria-hidden />
            <p className="text-sm text-ink-400">{t('announcements.comingSoon')}</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
