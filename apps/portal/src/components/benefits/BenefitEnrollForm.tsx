'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { enrollInBenefit } from '../../lib/api/benefits';
import { listEmployees } from '../../lib/api/employees';
import { ApiError } from '../../lib/api/client';
import type { BenefitPlan, Employee } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';

const today = new Date().toISOString().slice(0, 10);

/** No dedicated employee-picker abstraction exists in this codebase — reuses `listEmployees()` for a plain `<select>`, the SAME "no picker abstraction" posture asset assignment/interviewer pickers already document (see docs/conventions/frontend-admin-console.md). */
export function BenefitEnrollForm({ plans, onEnrolled, onCancel }: { plans: BenefitPlan[]; onEnrolled: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const [coverageTierId, setCoverageTierId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listEmployees({ pageSize: 100 }).then((res) => {
      setEmployees(res.data);
      if (res.data[0]) setEmployeeId(res.data[0].id);
    });
  }, []);

  const selectedPlan = plans.find((p) => p.id === planId);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await enrollInBenefit({
        employeeId,
        planId,
        coverageTierId: selectedPlan?.hasTiers ? coverageTierId || undefined : undefined,
        effectiveFrom,
      });
      onEnrolled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="enroll-employee">{t('benefits.admin.enrollEmployeeId')}</Label>
        <Select id="enroll-employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.firstName} {employee.lastName} ({employee.employeeCode})
            </option>
          ))}
        </Select>
      </div>

      <div>
        <Label htmlFor="enroll-plan">{t('benefits.admin.plans')}</Label>
        <Select id="enroll-plan" value={planId} onChange={(e) => setPlanId(e.target.value)} required>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name}
            </option>
          ))}
        </Select>
      </div>

      {selectedPlan?.hasTiers && (
        <div>
          <Label htmlFor="enroll-tier">{t('benefits.coverageTier')}</Label>
          <Select id="enroll-tier" value={coverageTierId} onChange={(e) => setCoverageTierId(e.target.value)} required>
            <option value="" disabled>
              {t('benefits.coverageTier')}
            </option>
            {selectedPlan.tiers.map((tier) => (
              <option key={tier.id} value={tier.id}>
                {tier.label}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div>
        <Label htmlFor="enroll-effective-from">{t('benefits.effectiveFrom')}</Label>
        <Input id="enroll-effective-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-benefit-enroll-button">
          {t('benefits.admin.enroll')}
        </Button>
      </div>
    </form>
  );
}
