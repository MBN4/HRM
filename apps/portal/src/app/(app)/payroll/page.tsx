'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { listPayrollRuns } from '../../../lib/api/payroll';
import { listBranches } from '../../../lib/api/tenancy';
import { formatCurrency } from '../../../lib/format';
import { Card, CardBody } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { StatusBadge } from '../../../components/ui/Badge';
import { Label, Select } from '../../../components/ui/Field';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { CreateRunForm } from '../../../components/payroll/CreateRunForm';
import type { PayrollRun } from '../../../lib/api/types';

export default function PayrollPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const [branchFilter, setBranchFilter] = useState('');
  const [creating, setCreating] = useState(false);

  const canView = can(PERMISSIONS.PAYROLL_RUN) || can(PERMISSIONS.PAYROLL_APPROVE) || can(PERMISSIONS.PAYSLIP_VIEW);
  const canCreate = can(PERMISSIONS.PAYROLL_RUN);

  const { data: branches } = useAsync(() => (canView ? listBranches() : Promise.resolve([])), [canView]);
  const { data: runs, loading, reload } = useAsync(
    () => (canView ? listPayrollRuns({ branchId: branchFilter || undefined }) : Promise.resolve([])),
    [canView, branchFilter],
  );

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  function branchName(branchId: string): string {
    return branches?.find((b) => b.id === branchId)?.name ?? `${branchId.slice(0, 8)}…`;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('payroll.title')}</h1>
        {canCreate && (
          <Button data-testid="new-run-button" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('payroll.newRun')}
          </Button>
        )}
      </div>

      <div className="w-56">
        <Label htmlFor="payroll-branch">{t('common.branch')}</Label>
        <Select id="payroll-branch" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
          <option value="">{t('analytics.filters.allBranches')}</option>
          {(branches ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !runs || runs.length === 0 ? (
            <EmptyState title={t('payroll.noRuns')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                    <th className="py-2 text-start font-medium">{t('common.branch')}</th>
                    <th className="py-2 text-start font-medium">{t('payroll.period')}</th>
                    <th className="py-2 text-start font-medium">{t('common.status')}</th>
                    <th className="py-2 text-start font-medium">{t('payroll.currency')}</th>
                    <th className="py-2 text-start font-medium">{t('payroll.totalGross')}</th>
                    <th className="py-2 text-start font-medium">{t('payroll.totalNet')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {runs.map((run: PayrollRun) => (
                    <tr
                      key={run.id}
                      data-testid="payroll-run-row"
                      data-status={run.status}
                      className="cursor-pointer hover:bg-sand-50"
                      onClick={() => router.push(`/payroll/${run.id}`)}
                    >
                      <td className="py-2.5 text-ink-800">{branchName(run.branchId)}</td>
                      <td className="py-2.5 text-ink-600">
                        {run.periodMonth}/{run.periodYear}
                      </td>
                      <td className="py-2.5">
                        <StatusBadge status={run.status} label={t(`payroll.status.${run.status}`)} />
                      </td>
                      <td className="py-2.5 text-ink-600">{run.currencyCode}</td>
                      <td className="py-2.5 text-ink-600">
                        {'totalGross' in run ? formatCurrency(Number(run.totalGross), run.currencyCode, locale) : '—'}
                      </td>
                      <td className="py-2.5 text-ink-600">
                        {'totalNet' in run ? formatCurrency(Number(run.totalNet), run.currencyCode, locale) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {creating && (
        <Modal title={t('payroll.newRun')} onClose={() => setCreating(false)}>
          <CreateRunForm
            onCancel={() => setCreating(false)}
            onCreated={(run) => {
              setCreating(false);
              reload();
              router.push(`/payroll/${run.id}`);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
