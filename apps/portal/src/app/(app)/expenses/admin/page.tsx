'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useAsync } from '../../../../lib/useAsync';
import { listExpenseCategories, listExpenseClaims } from '../../../../lib/api/expenses';
import { formatCurrency } from '../../../../lib/format';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { Alert } from '../../../../components/ui/Alert';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { ExpenseCategoryForm } from '../../../../components/expenses/ExpenseCategoryForm';
import { ExpenseClaimRow } from '../../../../components/expenses/ExpenseClaimRow';

export default function ExpensesAdminPage() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [addingCategory, setAddingCategory] = useState(false);

  const canManage = can(PERMISSIONS.EXPENSE_MANAGE);
  const { data: categories, reload: reloadCategories } = useAsync(() => (canManage ? listExpenseCategories() : Promise.resolve([])), [canManage]);
  const { data: claims, loading } = useAsync(() => (canManage ? listExpenseClaims() : Promise.resolve([])), [canManage]);

  if (!canManage) {
    return <Alert tone="info">{t('error.forbidden')}</Alert>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('expenses.admin.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('expenses.admin.categories')}</CardTitle>
          <Button size="sm" onClick={() => setAddingCategory(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('expenses.admin.newCategory')}
          </Button>
        </CardHeader>
        <CardBody>
          {!categories || categories.length === 0 ? (
            <p className="text-sm text-ink-400">{t('common.noData')}</p>
          ) : (
            <ul className="divide-y divide-ink-100 text-sm">
              {categories.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2">
                  <span className="text-ink-800">
                    {c.name} <span className="text-ink-400">({c.code})</span>
                  </span>
                  <span className="text-ink-500">
                    {c.policyLimitAmount ? `${t('expenses.admin.policyLimit')}: ${c.policyLimitAmount}` : t('common.no') + ' ' + t('expenses.admin.policyLimit').toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('expenses.admin.allClaims')}</CardTitle>
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

      {addingCategory && (
        <Modal title={t('expenses.admin.newCategory')} onClose={() => setAddingCategory(false)}>
          <ExpenseCategoryForm
            onCancel={() => setAddingCategory(false)}
            onSaved={() => {
              setAddingCategory(false);
              reloadCategories();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
