'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../i18n/I18nProvider';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useAsync } from '../../../lib/useAsync';
import { listExpenseCategories, listExpenseClaims } from '../../../lib/api/expenses';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { PageSpinner } from '../../../components/ui/Spinner';
import { NewExpenseClaimForm } from '../../../components/expenses/NewExpenseClaimForm';
import { ExpenseClaimRow } from '../../../components/expenses/ExpenseClaimRow';

export default function ExpensesPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);

  const canView = can(PERMISSIONS.EXPENSE_READ);
  const { data: categories } = useAsync(() => (canView ? listExpenseCategories() : Promise.resolve([])), [canView]);
  const { data: claims, loading, reload } = useAsync(() => (canView ? listExpenseClaims() : Promise.resolve([])), [canView]);

  if (!canView) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{t('expenses.title')}</h1>
        <Button data-testid="new-expense-claim-button" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          {t('expenses.newClaim')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('expenses.myClaims')}</CardTitle>
        </CardHeader>
        <CardBody>
          {loading ? (
            <PageSpinner />
          ) : !claims || claims.length === 0 ? (
            <EmptyState title={t('expenses.noClaims')} />
          ) : (
            <div className="divide-y divide-ink-100">
              {claims.map((claim) => (
                <ExpenseClaimRow key={claim.id} claim={claim} categories={categories ?? []} locale={locale} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {creating && (
        <Modal title={t('expenses.newClaim')} onClose={() => setCreating(false)}>
          <NewExpenseClaimForm
            onCancel={() => setCreating(false)}
            onSubmitted={() => {
              setCreating(false);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
