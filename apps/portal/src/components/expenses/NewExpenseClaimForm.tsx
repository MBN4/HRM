'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { addExpenseLine, createExpenseClaimDraft, listExpenseCategories, submitExpenseClaim, uploadReceipt } from '../../lib/api/expenses';
import { ApiError } from '../../lib/api/client';
import type { ExpenseCategory, ExpenseClaim, ExpenseLine } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';
import { PageSpinner } from '../ui/Spinner';

/**
 * Creates the DRAFT claim as soon as the modal opens (matching the
 * backend's own draft-then-add-lines shape), lets the caller add several
 * line items — each persisted immediately, never held only in local state
 * — then submits once at least one line exists. Cancelling leaves the
 * DRAFT claim behind, unsubmitted — the same "orphaned draft, no discard
 * route" simplification this step's scope didn't ask to close.
 */
export function NewExpenseClaimForm({ onSubmitted, onCancel }: { onSubmitted: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [claim, setClaim] = useState<ExpenseClaim | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [lines, setLines] = useState<ExpenseLine[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [draft, cats] = await Promise.all([createExpenseClaimDraft(), listExpenseCategories()]);
      setClaim(draft);
      setCategories(cats);
      if (cats[0]) setCategoryId(cats[0].id);
    })();
  }, []);

  async function handleAddLine(e: FormEvent) {
    e.preventDefault();
    if (!claim) return;
    setBusy(true);
    setError(null);
    try {
      let line = await addExpenseLine(claim.id, { categoryId, description, amount: Number(amount), expenseDate });
      if (receiptFile) {
        line = await uploadReceipt(claim.id, line.id, receiptFile);
      }
      setLines((current) => [...current, line]);
      setDescription('');
      setAmount('');
      setReceiptFile(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitClaim() {
    if (!claim) return;
    setBusy(true);
    setError(null);
    try {
      await submitExpenseClaim(claim.id);
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  if (!claim) return <PageSpinner />;

  return (
    <div className="space-y-4">
      {lines.length > 0 && (
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-100">
          {lines.map((line) => (
            <li key={line.id} data-testid="expense-line-row" className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-ink-700">{line.description}</span>
              <span className="font-medium text-ink-800">
                {line.amount} {claim.currencyCode}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAddLine} className="space-y-3 rounded-lg bg-sand-50 p-3">
        <div>
          <Label htmlFor="expense-category">{t('expenses.category')}</Label>
          <Select id="expense-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="expense-description">{t('expenses.description')}</Label>
          <Input id="expense-description" value={description} onChange={(e) => setDescription(e.target.value)} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="expense-amount">
              {t('expenses.amount')} ({claim.currencyCode})
            </Label>
            <Input id="expense-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="expense-date">{t('expenses.date')}</Label>
            <Input id="expense-date" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} required />
          </div>
        </div>
        <div>
          <Label htmlFor="expense-receipt">
            {t('expenses.receipt')} <span className="text-ink-400">({t('common.optional')})</span>
          </Label>
          <input
            id="expense-receipt"
            type="file"
            onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
            className="block text-sm text-ink-600"
          />
        </div>
        <Button type="submit" variant="secondary" size="sm" loading={busy} data-testid="add-expense-line-button">
          {t('expenses.addLine')}
        </Button>
      </form>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="button" loading={busy} disabled={lines.length === 0} onClick={handleSubmitClaim} data-testid="submit-expense-claim-button">
          {t('expenses.submitClaim')}
        </Button>
      </div>
    </div>
  );
}
