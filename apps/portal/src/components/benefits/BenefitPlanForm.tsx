'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { upsertBenefitPlan, type UpsertBenefitPlanInput } from '../../lib/api/benefits';
import { ApiError } from '../../lib/api/client';
import type { BenefitType } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Field';
import { Alert } from '../ui/Alert';

const BENEFIT_TYPES: BenefitType[] = ['HEALTH_INSURANCE', 'PROVIDENT_FUND', 'PENSION', 'LIFE_INSURANCE', 'BONUS_INCENTIVE', 'ALLOWANCE', 'OTHER'];

interface TierRow {
  key: string;
  label: string;
  employeeAmount: string;
  employerAmount: string;
}

export function BenefitPlanForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [benefitType, setBenefitType] = useState<BenefitType>('HEALTH_INSURANCE');
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [costBasis, setCostBasis] = useState<'FIXED_AMOUNT' | 'PERCENTAGE_OF_BASE'>('FIXED_AMOUNT');
  const [fixedAmount, setFixedAmount] = useState('');
  const [percentageOfBase, setPercentageOfBase] = useState<'basicSalary' | 'grossSalary' | 'monthlySalary' | 'annualSalary'>('grossSalary');
  const [percentageRate, setPercentageRate] = useState('');
  const [employeeSharePercent, setEmployeeSharePercent] = useState('0.5');
  const [employerSharePercent, setEmployerSharePercent] = useState('0.5');
  const [hasTiers, setHasTiers] = useState(false);
  const [tiers, setTiers] = useState<TierRow[]>([{ key: '', label: '', employeeAmount: '', employerAmount: '' }]);
  const [allowSelfElection, setAllowSelfElection] = useState(false);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [affectsPayroll, setAffectsPayroll] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateTier(index: number, patch: Partial<TierRow>) {
    setTiers((current) => current.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const base: Omit<UpsertBenefitPlanInput, 'costBasis' | 'fixedAmount' | 'percentageOfBase' | 'percentageRate'> = {
        code,
        name,
        benefitType,
        currencyCode,
        employeeSharePercent: Number(employeeSharePercent),
        employerSharePercent: Number(employerSharePercent),
        hasTiers,
        tiers: hasTiers
          ? tiers.map((tier, i) => ({ key: tier.key, label: tier.label, employeeAmount: Number(tier.employeeAmount), employerAmount: Number(tier.employerAmount), order: i }))
          : [],
        allowSelfElection,
        requiresApproval,
        affectsPayroll,
      };
      const input: UpsertBenefitPlanInput =
        costBasis === 'FIXED_AMOUNT'
          ? { ...base, costBasis: 'FIXED_AMOUNT', fixedAmount: Number(fixedAmount) || 0 }
          : { ...base, costBasis: 'PERCENTAGE_OF_BASE', percentageOfBase, percentageRate: Number(percentageRate) || 0 };
      await upsertBenefitPlan(input);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="plan-code">{t('benefits.admin.code')}</Label>
          <Input id="plan-code" value={code} onChange={(e) => setCode(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="plan-name">{t('benefits.admin.name')}</Label>
          <Input id="plan-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="plan-type">{t('benefits.admin.benefitType')}</Label>
          <Select id="plan-type" value={benefitType} onChange={(e) => setBenefitType(e.target.value as BenefitType)}>
            {BENEFIT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`benefits.type.${type}`)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="plan-currency">{t('benefits.admin.currency')}</Label>
          <Input id="plan-currency" value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())} maxLength={3} required />
        </div>
      </div>

      <div>
        <Label htmlFor="plan-cost-basis">{t('benefits.admin.costBasis')}</Label>
        <Select id="plan-cost-basis" value={costBasis} onChange={(e) => setCostBasis(e.target.value as 'FIXED_AMOUNT' | 'PERCENTAGE_OF_BASE')} disabled={hasTiers}>
          <option value="FIXED_AMOUNT">{t('benefits.admin.costBasis.FIXED_AMOUNT')}</option>
          <option value="PERCENTAGE_OF_BASE">{t('benefits.admin.costBasis.PERCENTAGE_OF_BASE')}</option>
        </Select>
        <p className="mt-1 text-xs text-ink-400">{t('benefits.admin.formulaPlanNotice')}</p>
      </div>

      <div className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" id="plan-has-tiers" checked={hasTiers} onChange={(e) => setHasTiers(e.target.checked)} />
        <label htmlFor="plan-has-tiers">{t('benefits.admin.hasTiers')}</label>
      </div>

      {hasTiers ? (
        <div className="space-y-3 rounded-lg bg-sand-50 p-3">
          <Label>{t('benefits.admin.tiers')}</Label>
          {tiers.map((tier, i) => (
            <div key={i} className="grid grid-cols-4 gap-2" data-testid="benefit-tier-row">
              <Input placeholder={t('benefits.admin.tierKey')} value={tier.key} onChange={(e) => updateTier(i, { key: e.target.value })} required />
              <Input placeholder={t('benefits.admin.tierLabel')} value={tier.label} onChange={(e) => updateTier(i, { label: e.target.value })} required />
              <Input type="number" step="0.01" placeholder={t('benefits.admin.tierEmployeeAmount')} value={tier.employeeAmount} onChange={(e) => updateTier(i, { employeeAmount: e.target.value })} required />
              <Input type="number" step="0.01" placeholder={t('benefits.admin.tierEmployerAmount')} value={tier.employerAmount} onChange={(e) => updateTier(i, { employerAmount: e.target.value })} required />
            </div>
          ))}
          <Button type="button" variant="secondary" size="sm" onClick={() => setTiers((current) => [...current, { key: '', label: '', employeeAmount: '', employerAmount: '' }])}>
            {t('benefits.admin.addTier')}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {costBasis === 'FIXED_AMOUNT' ? (
            <div>
              <Label htmlFor="plan-fixed-amount">{t('benefits.admin.fixedAmount')}</Label>
              <Input id="plan-fixed-amount" type="number" step="0.01" min="0" value={fixedAmount} onChange={(e) => setFixedAmount(e.target.value)} required />
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="plan-percentage-base">{t('benefits.admin.percentageOfBase')}</Label>
                <Select id="plan-percentage-base" value={percentageOfBase} onChange={(e) => setPercentageOfBase(e.target.value as typeof percentageOfBase)}>
                  <option value="grossSalary">grossSalary</option>
                  <option value="basicSalary">basicSalary</option>
                  <option value="monthlySalary">monthlySalary</option>
                  <option value="annualSalary">annualSalary</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="plan-percentage-rate">{t('benefits.admin.percentageRate')}</Label>
                <Input id="plan-percentage-rate" type="number" step="0.001" min="0" max="1" value={percentageRate} onChange={(e) => setPercentageRate(e.target.value)} required />
              </div>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="plan-employee-share">{t('benefits.admin.employeeShare')}</Label>
          <Input id="plan-employee-share" type="number" step="0.01" min="0" max="1" value={employeeSharePercent} onChange={(e) => setEmployeeSharePercent(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="plan-employer-share">{t('benefits.admin.employerShare')}</Label>
          <Input id="plan-employer-share" type="number" step="0.01" min="0" max="1" value={employerSharePercent} onChange={(e) => setEmployerSharePercent(e.target.value)} required />
        </div>
      </div>
      <p className="text-xs text-ink-400">{t('benefits.admin.shareSumHint')}</p>

      <div className="space-y-2 text-sm text-ink-700">
        <div className="flex items-center gap-2">
          <input type="checkbox" id="plan-self-election" checked={allowSelfElection} onChange={(e) => setAllowSelfElection(e.target.checked)} />
          <label htmlFor="plan-self-election">{t('benefits.admin.allowSelfElection')}</label>
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="plan-requires-approval" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
          <label htmlFor="plan-requires-approval">{t('benefits.admin.requiresApproval')}</label>
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="plan-affects-payroll" checked={affectsPayroll} onChange={(e) => setAffectsPayroll(e.target.checked)} />
          <label htmlFor="plan-affects-payroll">{t('benefits.admin.affectsPayroll')}</label>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={submitting} data-testid="save-benefit-plan-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
