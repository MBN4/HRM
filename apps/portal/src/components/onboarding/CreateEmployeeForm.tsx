'use client';

import { FormEvent, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { listEmployees } from '../../lib/api/employees';
import { createEmployeeFromOnboarding } from '../../lib/api/onboarding';
import { ApiError } from '../../lib/api/client';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';

interface StatutoryFieldRow {
  key: string;
  value: string;
}

/**
 * The most complex form in this stage — see docs/conventions/
 * recruitment-lifecycle.md. `statutoryFields` is a free-form dynamic
 * key/value list (no schema-introspection endpoint exists to know which
 * keys a given branch's Country Pack requires up front — the caller
 * fills in whatever the branch needs, e.g. `SSN`/`W4` for a US branch,
 * and a missing required key surfaces as a 400 from
 * `EmployeeService.create`, rendered below via `<Alert tone="error">`).
 * No department/designation pickers (documented limitation).
 */
export function CreateEmployeeForm({ processId, onCreated, onCancel }: { processId: string; onCreated: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { data: employeeResult } = useAsync(() => listEmployees({ pageSize: 200 }), []);

  const [employeeCode, setEmployeeCode] = useState('');
  const [statutoryFields, setStatutoryFields] = useState<StatutoryFieldRow[]>([{ key: '', value: '' }]);
  const [accountNumber, setAccountNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [routingCode, setRoutingCode] = useState('');
  const [baseSalary, setBaseSalary] = useState('');
  const [currency, setCurrency] = useState('');
  const [managerId, setManagerId] = useState('');
  const [joinDate, setJoinDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateField(index: number, patch: Partial<StatutoryFieldRow>) {
    setStatutoryFields((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeField(index: number) {
    setStatutoryFields((rows) => rows.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!employeeCode) return;
    setSubmitting(true);
    setError(null);
    try {
      const statutoryFieldsRecord: Record<string, string> = {};
      for (const row of statutoryFields) {
        if (row.key.trim()) statutoryFieldsRecord[row.key.trim()] = row.value;
      }

      const hasBankDetails = accountNumber || bankName || routingCode;
      const hasCompensation = baseSalary.length > 0;

      await createEmployeeFromOnboarding(processId, {
        employeeCode,
        managerId: managerId || undefined,
        statutoryFields: statutoryFieldsRecord,
        bankDetails: hasBankDetails
          ? { accountNumber: accountNumber || undefined, bankName: bankName || undefined, routingCode: routingCode || undefined }
          : undefined,
        compensation: hasCompensation ? { baseSalary: Number(baseSalary), currency: currency || undefined } : undefined,
        joinDate: joinDate || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="onboarding-employee-code">{t('onboarding.employeeCode')}</Label>
        <Input id="onboarding-employee-code" value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} required />
      </div>

      <div>
        <Label htmlFor="onboarding-manager">
          {t('profile.manager')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Select id="onboarding-manager" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">—</option>
          {(employeeResult?.data ?? []).map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.firstName} {employee.lastName} ({employee.employeeCode})
            </option>
          ))}
        </Select>
      </div>

      <div>
        <Label htmlFor="onboarding-join-date">
          {t('profile.joinDate')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <Input id="onboarding-join-date" type="date" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} />
      </div>

      <div>
        <Label>{t('onboarding.statutoryFields')}</Label>
        <div className="space-y-2">
          {statutoryFields.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={t('onboarding.fieldKey')}
                placeholder={t('onboarding.fieldKey')}
                data-testid="statutory-field-key"
                value={row.key}
                onChange={(e) => updateField(index, { key: e.target.value })}
              />
              <Input
                aria-label={t('onboarding.fieldValue')}
                placeholder={t('onboarding.fieldValue')}
                data-testid="statutory-field-value"
                value={row.value}
                onChange={(e) => updateField(index, { value: e.target.value })}
              />
              <button type="button" onClick={() => removeField(index)} className="shrink-0 rounded-md p-1.5 text-ink-400 hover:bg-sand-100 hover:text-coral-600">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          data-testid="add-statutory-field-button"
          onClick={() => setStatutoryFields((rows) => [...rows, { key: '', value: '' }])}
          className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t('onboarding.addField')}
        </button>
      </div>

      <div>
        <Label>
          {t('onboarding.bankDetails')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <div className="grid grid-cols-3 gap-2">
          <Input placeholder={t('profile.accountNumber')} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
          <Input placeholder={t('profile.bankName')} value={bankName} onChange={(e) => setBankName(e.target.value)} />
          <Input placeholder={t('onboarding.routingCode')} value={routingCode} onChange={(e) => setRoutingCode(e.target.value)} />
        </div>
      </div>

      <div>
        <Label>
          {t('onboarding.compensation')} <span className="text-ink-400">({t('common.optional')})</span>
        </Label>
        <div className="grid grid-cols-2 gap-2">
          <Input type="number" placeholder={t('profile.baseSalary')} value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} />
          <Input placeholder={t('recruitment.salaryCurrency')} value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-create-employee-button">
          {t('onboarding.createEmployee')}
        </Button>
      </div>
    </form>
  );
}
