'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { useAuth } from '../../lib/auth/AuthContext';
import { downloadPayslip } from '../../lib/api/payroll';
import { ApiError } from '../../lib/api/client';
import { formatCurrency } from '../../lib/format';
import { Button } from '../ui/Button';
import { StatusBadge } from '../ui/Badge';
import { Alert } from '../ui/Alert';
import type { PayrollRunLine } from '../../lib/api/types';

function ComponentBreakdown({ breakdown }: { breakdown: unknown }) {
  if (!breakdown || typeof breakdown !== 'object') return null;
  const entries = Object.entries(breakdown as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-ink-500">
      {entries.map(([key, value]) => (
        <li key={key}>
          {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
        </li>
      ))}
    </ul>
  );
}

function PayslipDownloadButton({ runId, employeeId }: { runId: string; employeeId: string }) {
  const { t } = useI18n();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      await downloadPayslip(runId, employeeId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div>
      <Button data-testid="download-payslip-button" variant="secondary" size="sm" loading={downloading} onClick={handleDownload}>
        <Download className="h-3.5 w-3.5" aria-hidden />
        {t('payroll.downloadPayslip')}
      </Button>
      {error && (
        <div className="mt-1">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </div>
  );
}

export function PayrollLinesTable({ runId, lines, currencyCode }: { runId: string; lines: PayrollRunLine[]; currencyCode: string }) {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const canReadEmployee = can(PERMISSIONS.EMPLOYEE_READ);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-start text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
            <th className="py-2 text-start font-medium">{t('common.employee')}</th>
            <th className="py-2 text-start font-medium">{t('common.status')}</th>
            <th className="py-2 text-start font-medium">{t('common.type')}</th>
            <th className="py-2 text-start font-medium">{t('payroll.totalGross')}</th>
            <th className="py-2 text-start font-medium">{t('payroll.totalNet')}</th>
            <th className="py-2 text-start font-medium">{t('payroll.totalEmployerCost')}</th>
            <th className="py-2 text-start font-medium">{t('common.actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {lines.map((line) => {
            const hasAmounts = 'grossPay' in line;
            return (
              <tr key={line.id} data-testid="payroll-line-row" data-status={line.status}>
                <td className="py-2.5 text-ink-800">{line.employeeId}</td>
                <td className="py-2.5">
                  <StatusBadge status={line.status} label={t(`payroll.line.status.${line.status}`)} />
                  {line.status === 'FAILED' && line.errorMessage && (
                    <div className="mt-1">
                      <Alert tone="error">{line.errorMessage}</Alert>
                    </div>
                  )}
                </td>
                <td className="py-2.5 text-ink-600">{line.computedVia ? t(`payroll.computedVia.${line.computedVia}`) : '—'}</td>
                <td className="py-2.5 text-ink-600">
                  {hasAmounts ? (
                    <span data-testid="line-gross-pay">{formatCurrency(Number(line.grossPay), currencyCode, locale)}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="py-2.5 text-ink-600">
                  {hasAmounts ? (
                    <span data-testid="line-net-pay">{formatCurrency(Number(line.netPay), currencyCode, locale)}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="py-2.5 text-ink-600">
                  {hasAmounts ? formatCurrency(Number(line.employerCost), currencyCode, locale) : '—'}
                  {hasAmounts && line.componentBreakdown ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-ink-400">{t('payroll.componentBreakdown')}</summary>
                      <ComponentBreakdown breakdown={line.componentBreakdown} />
                    </details>
                  ) : null}
                </td>
                <td className="py-2.5">
                  {canReadEmployee && line.status === 'COMPUTED' && <PayslipDownloadButton runId={runId} employeeId={line.employeeId} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
