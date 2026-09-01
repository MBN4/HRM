'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { listEmployees } from '../../lib/api/employees';
import { initiateOffboarding } from '../../lib/api/offboarding';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';
import type { OffboardingProcess, OffboardingReason } from '../../lib/api/types';

const REASONS: OffboardingReason[] = ['RESIGNATION', 'TERMINATION'];

export function InitiateOffboardingForm({ onInitiated, onCancel }: { onInitiated: (process: OffboardingProcess) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: employeeResult } = useAsync(() => listEmployees({ pageSize: 200 }), []);
  const [employeeId, setEmployeeId] = useState('');
  const [reason, setReason] = useState<OffboardingReason>('RESIGNATION');
  const [lastWorkingDate, setLastWorkingDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!employeeId || !lastWorkingDate) return;
    setSubmitting(true);
    setError(null);
    try {
      const process = await initiateOffboarding({ employeeId, reason, lastWorkingDate });
      onInitiated(process);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="offboarding-employee">{t('common.employee')}</Label>
        <Select id="offboarding-employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
          <option value="" disabled>
            {t('common.employee')}
          </option>
          {(employeeResult?.data ?? []).map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.firstName} {employee.lastName} ({employee.employeeCode})
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="offboarding-reason">{t('common.reason')}</Label>
        <Select id="offboarding-reason" value={reason} onChange={(e) => setReason(e.target.value as OffboardingReason)}>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`offboarding.reasonValue.${r}`)}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="offboarding-last-working-date">{t('offboarding.lastWorkingDate')}</Label>
        <Input id="offboarding-last-working-date" type="date" value={lastWorkingDate} onChange={(e) => setLastWorkingDate(e.target.value)} required />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} disabled={!employeeId || !lastWorkingDate} data-testid="submit-initiate-offboarding-button">
          {t('offboarding.initiate')}
        </Button>
      </div>
    </form>
  );
}
