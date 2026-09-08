'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { enrollInBenefit } from '../../lib/api/benefits';
import { ApiError } from '../../lib/api/client';
import type { BenefitPlan, EmployeeDependent } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';

const today = new Date().toISOString().slice(0, 10);

export function BenefitElectForm({
  plan,
  dependents,
  onEnrolled,
  onCancel,
}: {
  plan: BenefitPlan;
  dependents: EmployeeDependent[];
  onEnrolled: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [coverageTierId, setCoverageTierId] = useState(plan.tiers[0]?.id ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [dependentIds, setDependentIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleDependent(id: string) {
    setDependentIds((current) => (current.includes(id) ? current.filter((d) => d !== id) : [...current, id]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await enrollInBenefit({
        planId: plan.id,
        coverageTierId: plan.hasTiers ? coverageTierId : undefined,
        effectiveFrom,
        dependentIds,
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
      {plan.hasTiers && (
        <div>
          <Label htmlFor="elect-tier">{t('benefits.coverageTier')}</Label>
          <Select id="elect-tier" value={coverageTierId} onChange={(e) => setCoverageTierId(e.target.value)} required>
            {plan.tiers.map((tier) => (
              <option key={tier.id} value={tier.id}>
                {tier.label}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div>
        <Label htmlFor="elect-effective-from">{t('benefits.effectiveFrom')}</Label>
        <Input id="elect-effective-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
      </div>

      <div>
        <Label>{t('benefits.dependents')}</Label>
        <p className="mb-1.5 text-xs text-ink-400">{t('benefits.electModal.dependentsHint')}</p>
        {dependents.length === 0 ? (
          <p className="text-sm text-ink-400">{t('benefits.noDependents')}</p>
        ) : (
          <ul className="space-y-1.5">
            {dependents.map((dependent) => (
              <li key={dependent.id} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  id={`dependent-${dependent.id}`}
                  checked={dependentIds.includes(dependent.id)}
                  onChange={() => toggleDependent(dependent.id)}
                />
                <label htmlFor={`dependent-${dependent.id}`}>
                  {dependent.name} <span className="text-ink-400">({dependent.relationship})</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="submit-benefit-election-button">
          {t('benefits.elect')}
        </Button>
      </div>
    </form>
  );
}
