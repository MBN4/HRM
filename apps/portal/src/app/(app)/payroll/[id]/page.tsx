'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { formatCurrency } from '../../../../lib/format';
import {
  bankExportPayrollRun,
  calculatePayrollRun,
  finalizePayrollRun,
  getPayrollRun,
  markPayrollRunPaid,
  submitPayrollRunForApproval,
} from '../../../../lib/api/payroll';
import { listBranches } from '../../../../lib/api/tenancy';
import { ApiError } from '../../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Alert } from '../../../../components/ui/Alert';
import { StatusBadge } from '../../../../components/ui/Badge';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { PayrollLinesTable } from '../../../../components/payroll/PayrollLinesTable';
import { WorkflowStatusPanel } from '../../../../components/workflow/WorkflowStatusPanel';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-800">{value || '—'}</dd>
    </div>
  );
}

export default function PayrollRunDetailPage({ params }: { params: { id: string } }) {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const canView = can(PERMISSIONS.PAYROLL_RUN) || can(PERMISSIONS.PAYROLL_APPROVE) || can(PERMISSIONS.PAYSLIP_VIEW);

  const { data: branches } = useAsync(() => (canView ? listBranches() : Promise.resolve([])), [canView]);
  const { data: run, loading, error, reload } = useAsync(() => (canView ? getPayrollRun(params.id) : Promise.resolve(null)), [canView, params.id]);

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  if (loading) return <PageSpinner />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!run) return <Alert tone="info">{t('error.notFound')}</Alert>;

  const branchName = branches?.find((b) => b.id === run.branchId)?.name ?? run.branchId;
  const hasTotals = 'totalGross' in run;

  async function runAction(actionKey: string, action: () => Promise<unknown>, note?: string) {
    setBusyAction(actionKey);
    setActionError(null);
    setActionNote(null);
    try {
      await action();
      if (note) {
        setActionNote(note);
      } else {
        reload();
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusyAction(null);
    }
  }

  const canCalculate = can(PERMISSIONS.PAYROLL_RUN) && ['DRAFT', 'CALCULATED'].includes(run.status);
  const canSubmit = can(PERMISSIONS.PAYROLL_RUN) && run.status === 'CALCULATED' && !run.workflowInstanceId;
  const canFinalize = can(PERMISSIONS.PAYROLL_APPROVE) && run.status === 'APPROVED';
  const canMarkPaid = can(PERMISSIONS.PAYROLL_APPROVE) && run.status === 'FINALIZED';
  const canBankExport = can(PERMISSIONS.PAYROLL_APPROVE) && ['FINALIZED', 'PAID'].includes(run.status);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('payroll.title')}</h1>
        <Button data-testid="refresh-button" variant="secondary" size="sm" onClick={() => reload()}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t('payroll.refresh')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {branchName} — {run.periodMonth}/{run.periodYear}
          </CardTitle>
          <span data-testid="run-status-badge">
            <StatusBadge status={run.status} label={t(`payroll.status.${run.status}`)} />
          </span>
        </CardHeader>
        <CardBody className="space-y-4">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('common.branch')} value={branchName} />
            <Field label={t('payroll.period')} value={`${run.periodMonth}/${run.periodYear}`} />
            <Field label={t('payroll.currency')} value={run.currencyCode} />
            <Field label={t('common.status')} value={<StatusBadge status={run.status} label={t(`payroll.status.${run.status}`)} />} />
          </dl>

          {hasTotals ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="run-totals">
              <Field label={t('payroll.totalGross')} value={<span data-testid="run-total-gross">{formatCurrency(Number(run.totalGross), run.currencyCode, locale)}</span>} />
              <Field label={t('payroll.totalNet')} value={<span data-testid="run-total-net">{formatCurrency(Number(run.totalNet), run.currencyCode, locale)}</span>} />
              <Field label={t('payroll.totalEmployerCost')} value={formatCurrency(Number(run.totalEmployerCost), run.currencyCode, locale)} />
            </dl>
          ) : (
            <Alert tone="info">{t('payroll.noSalaryAccess')}</Alert>
          )}

          {actionError && <Alert tone="error">{actionError}</Alert>}
          {actionNote && <Alert tone="info">{actionNote}</Alert>}

          <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-4">
            {canCalculate && (
              <Button
                data-testid="calculate-run-button"
                variant="secondary"
                loading={busyAction === 'calculate'}
                onClick={() =>
                  runAction('calculate', () => calculatePayrollRun(run.id), t('payroll.calculating'))
                }
              >
                {t('payroll.calculate')}
              </Button>
            )}
            {canSubmit && (
              <Button
                data-testid="submit-run-button"
                loading={busyAction === 'submit'}
                onClick={() => runAction('submit', () => submitPayrollRunForApproval(run.id))}
              >
                {t('payroll.submitForApproval')}
              </Button>
            )}
            {canFinalize && (
              <Button
                data-testid="finalize-run-button"
                loading={busyAction === 'finalize'}
                onClick={() => runAction('finalize', () => finalizePayrollRun(run.id))}
              >
                {t('payroll.finalize')}
              </Button>
            )}
            {canMarkPaid && (
              <Button
                data-testid="mark-paid-button"
                loading={busyAction === 'mark-paid'}
                onClick={() => runAction('mark-paid', () => markPayrollRunPaid(run.id))}
              >
                {t('payroll.markPaid')}
              </Button>
            )}
            {canBankExport && (
              <Button
                data-testid="bank-export-button"
                variant="secondary"
                loading={busyAction === 'bank-export'}
                onClick={() => runAction('bank-export', () => bankExportPayrollRun(run.id))}
              >
                {t('payroll.bankExport')}
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <WorkflowStatusPanel workflowInstanceId={run.workflowInstanceId} />

      <Card>
        <CardHeader>
          <CardTitle>{t('payroll.lines')}</CardTitle>
        </CardHeader>
        <CardBody>
          {!run.lines || run.lines.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <PayrollLinesTable runId={run.id} lines={run.lines} currencyCode={run.currencyCode} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
