'use client';

import { useI18n } from '../../i18n/I18nProvider';
import { downloadReceipt } from '../../lib/api/expenses';
import { formatCurrency, formatDate } from '../../lib/format';
import type { ExpenseCategory, ExpenseClaim } from '../../lib/api/types';
import { StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { WorkflowStatusPanel } from '../workflow/WorkflowStatusPanel';

export function ExpenseClaimRow({ claim, categories, locale }: { claim: ExpenseClaim; categories: ExpenseCategory[]; locale: string }) {
  const { t } = useI18n();

  function categoryName(categoryId: string): string {
    return categories.find((c) => c.id === categoryId)?.name ?? categoryId.slice(0, 8);
  }

  return (
    <details className="group" data-testid="expense-claim-row">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-1 py-2.5 text-sm hover:bg-sand-50">
        <span className="text-ink-800">{formatDate(claim.createdAt, locale)}</span>
        <span className="font-medium text-ink-800">{formatCurrency(Number(claim.totalAmount), claim.currencyCode, locale)}</span>
        <StatusBadge status={claim.status} label={t(`expenses.status.${claim.status}`)} />
      </summary>
      <div className="space-y-3 border-t border-ink-100 px-1 py-3">
        {claim.lines && claim.lines.length > 0 && (
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-400">
                <th className="py-1 text-start font-medium">{t('expenses.category')}</th>
                <th className="py-1 text-start font-medium">{t('expenses.description')}</th>
                <th className="py-1 text-start font-medium">{t('expenses.amount')}</th>
                <th className="py-1 text-start font-medium">{t('expenses.receipt')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {claim.lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-1.5 text-ink-700">{categoryName(line.categoryId)}</td>
                  <td className="py-1.5 text-ink-700">{line.description}</td>
                  <td className="py-1.5 text-ink-700">{formatCurrency(Number(line.amount), claim.currencyCode, locale)}</td>
                  <td className="py-1.5">
                    {line.receiptStorageKey ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => downloadReceipt(claim.id, line.id, `receipt-${line.id}`)}
                      >
                        {t('expenses.downloadReceipt')}
                      </Button>
                    ) : (
                      <span className="text-ink-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <WorkflowStatusPanel workflowInstanceId={claim.workflowInstanceId} />
      </div>
    </details>
  );
}
