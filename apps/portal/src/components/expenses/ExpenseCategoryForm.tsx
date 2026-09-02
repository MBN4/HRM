'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { upsertExpenseCategory } from '../../lib/api/expenses';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Field';
import { Alert } from '../ui/Alert';

export function ExpenseCategoryForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [policyLimitAmount, setPolicyLimitAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await upsertExpenseCategory({ code, name, policyLimitAmount: policyLimitAmount ? Number(policyLimitAmount) : undefined });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="category-code">{t('expenses.admin.code')}</Label>
        <Input id="category-code" value={code} onChange={(e) => setCode(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="category-name">{t('expenses.admin.name')}</Label>
        <Input id="category-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="category-limit">
          {t('expenses.admin.policyLimit')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Input id="category-limit" type="number" min="0" step="0.01" value={policyLimitAmount} onChange={(e) => setPolicyLimitAmount(e.target.value)} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting}>
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
