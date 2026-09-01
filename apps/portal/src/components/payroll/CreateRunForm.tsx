'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { createPayrollRun } from '../../lib/api/payroll';
import { listBranches } from '../../lib/api/tenancy';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';
import type { PayrollRun } from '../../lib/api/types';

const now = new Date();

export function CreateRunForm({ onCreated, onCancel }: { onCreated: (run: PayrollRun) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: branches } = useAsync(() => listBranches(), []);
  const [branchId, setBranchId] = useState('');
  const [periodYear, setPeriodYear] = useState(now.getFullYear());
  const [periodMonth, setPeriodMonth] = useState(now.getMonth() + 1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!branchId) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await createPayrollRun({ branchId, periodYear, periodMonth });
      onCreated(run);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="run-branch">{t('common.branch')}</Label>
        <Select id="run-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
          <option value="" disabled>
            {t('common.branch')}
          </option>
          {(branches ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="run-year">{t('payroll.periodYear')}</Label>
          <Input
            id="run-year"
            type="number"
            value={periodYear}
            onChange={(e) => setPeriodYear(Number(e.target.value))}
            required
          />
        </div>
        <div>
          <Label htmlFor="run-month">{t('payroll.periodMonth')}</Label>
          <Input
            id="run-month"
            type="number"
            min={1}
            max={12}
            value={periodMonth}
            onChange={(e) => setPeriodMonth(Number(e.target.value))}
            required
          />
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-new-run-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
