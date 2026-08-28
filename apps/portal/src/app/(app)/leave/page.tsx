'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '../../../i18n/I18nProvider';
import { useSession } from '../../../lib/session/SessionProvider';
import { useAsync } from '../../../lib/useAsync';
import { getLeaveBalances, listLeaveRequests } from '../../../lib/api/leave';
import { formatDate } from '../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { StatusBadge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { ApplyLeaveForm } from '../../../components/leave/ApplyLeaveForm';

export default function LeavePage() {
  const { t, locale } = useI18n();
  const { employee, employeeLoading } = useSession();
  const [applying, setApplying] = useState(false);

  const { data: balances, loading: balancesLoading } = useAsync(
    () => (employee ? getLeaveBalances({ employeeId: employee.id }) : Promise.resolve([])),
    [employee?.id],
  );
  const { data: requests, loading: requestsLoading, reload } = useAsync(
    () => (employee ? listLeaveRequests({ employeeId: employee.id }) : Promise.resolve([])),
    [employee?.id],
  );

  if (employeeLoading) return <PageSpinner />;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('leave.title')}</h1>
        {employee && (
          <Button data-testid="apply-leave-button" onClick={() => setApplying(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('leave.apply')}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('leave.balances')}</CardTitle>
        </CardHeader>
        <CardBody>
          {balancesLoading ? (
            <PageSpinner />
          ) : !balances || balances.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {balances.map((b) => (
                <div key={b.leaveType} className="rounded-lg bg-sand-50 p-3 text-center">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-400">{t(`leave.type.${b.leaveType}`)}</p>
                  <p className="mt-1 text-2xl font-semibold text-brand-700">{b.availableDays}</p>
                  <p className="text-xs text-ink-400">
                    {t('leave.entitled')}: {b.entitledDays}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('leave.history')}</CardTitle>
        </CardHeader>
        <CardBody>
          {requestsLoading ? (
            <PageSpinner />
          ) : !requests || requests.length === 0 ? (
            <EmptyState title={t('leave.noRequests')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('leave.leaveType')}</th>
                    <th className="py-2 text-start font-medium">{t('leave.startDate')}</th>
                    <th className="py-2 text-start font-medium">{t('leave.endDate')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {requests.map((r) => (
                    <tr key={r.id} data-testid="leave-request-row" data-status={r.status}>
                      <td className="py-2.5 text-ink-800">{t(`leave.type.${r.leaveType}`)}</td>
                      <td className="py-2.5 text-ink-600">{formatDate(r.startDate, locale)}</td>
                      <td className="py-2.5 text-ink-600">{formatDate(r.endDate, locale)}</td>
                      <td className="py-2.5">
                        <StatusBadge status={r.status} label={t(`leave.status.${r.status}`)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {applying && (
        <Modal title={t('leave.applyTitle')} onClose={() => setApplying(false)}>
          <ApplyLeaveForm
            onCancel={() => setApplying(false)}
            onSubmitted={() => {
              setApplying(false);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
